package com.menix.api;

import com.menix.service.ResumeTailoringValidator;
import org.apache.poi.xwpf.usermodel.*;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

import java.io.ByteArrayOutputStream;
import java.io.ByteArrayInputStream;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

@RestController
@RequestMapping("/api/ai")
public class TailoredResumeController {
    private static final String DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    private static final Logger logger = LoggerFactory.getLogger(TailoredResumeController.class);
    private static final Pattern LINK_PATTERN = Pattern.compile(
        "\\[([^\\]]+)]\\((https?://[^\\s)]+|mailto:[^\\s)]+)\\)|(https?://[^\\s<>]+|mailto:[^\\s<>]+)",
        Pattern.CASE_INSENSITIVE);
    private static final Pattern PHONE_PATTERN = Pattern.compile("(?<!\\d)\\+?\\d[\\d ()-]{7,}\\d(?!\\d)");
    public record TemplateEdit(String before, String after, String section, String relatedRequirement,
                               List<String> evidence, Boolean safeToApply) {
        public TemplateEdit(String before, String after) { this(before, after, null, null, List.of(), null); }
    }
    public record TailoredDocxRequest(String resumeText, String jobDescription, String fullName,
                                      String masterDocxBase64, List<TemplateEdit> templateEdits) {}

    @PostMapping(value = "/tailor-docx", produces = DOCX_TYPE)
    public ResponseEntity<byte[]> tailorDocx(@RequestBody TailoredDocxRequest request) {
        if (request == null || request.resumeText() == null || request.resumeText().isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Master resume text is required.");
        }
        if (request.masterDocxBase64() == null || request.masterDocxBase64().isBlank()) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                "Upload the original resume as DOCX to preserve its design. PDF or pasted-text resumes cannot be safely edited in place.");
        }
        try {
            byte[] source = Base64.getDecoder().decode(request.masterDocxBase64());
            String sourceText = extractDocumentText(source);
            String sourceStructure = documentStructureSignature(source);
            byte[] docx = editMasterTemplate(source, request.templateEdits() == null ? List.of() : request.templateEdits());
            String validation = validateGeneratedDocx(docx, sourceText, request.fullName());
            if (!sourceStructure.equals(documentStructureSignature(docx))) {
                throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                    "Resume validation failed: the tailored DOCX structure differs from the Master Resume.");
            }
            String date = LocalDate.now(ZoneId.of("Asia/Kolkata")).toString();
            String requestedName = request.fullName() == null || request.fullName().isBlank()
                ? request.resumeText().lines().findFirst().orElse("Candidate") : request.fullName();
            String safeName = requestedName.replaceAll("[^A-Za-z0-9_-]", "");
            if (safeName.isBlank()) safeName = "Candidate";
            String filename = safeName + "_ATS_Resume_" + date + ".docx";
            ResponseEntity.BodyBuilder response = ResponseEntity.ok().contentType(MediaType.parseMediaType(DOCX_TYPE))
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"" + filename + "\"")
                .header("X-Resume-Validation-Status", "passed")
                .header("X-Resume-Validation-Note", validation)
                .header(HttpHeaders.ACCESS_CONTROL_EXPOSE_HEADERS, "X-Resume-Validation-Status, X-Resume-Validation-Note, X-Resume-Format-Note");
            return response.body(docx);
        } catch (ResponseStatusException ex) {
            throw ex;
        } catch (Exception ex) {
            logger.error("Could not format tailored resume as DOCX", ex);
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "Could not format the resume.", ex);
        }
    }

    private String validateGeneratedDocx(byte[] bytes, String sourceText, String fullName) throws Exception {
        if (bytes == null || bytes.length == 0) throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY, "Resume validation failed: generated document is empty.");
        String extracted = extractDocumentText(bytes);
        String normalizedOutput = extracted.toLowerCase(Locale.ROOT).replaceAll("\\s+", " ");
        if (extracted.isBlank() || extracted.length() < Math.max(30, sourceText.length() / 2)) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY, "Resume validation failed: generated document is unreadable or missing substantial content.");
        }
        if (fullName != null && !fullName.isBlank()
            && !normalizedOutput.contains(fullName.toLowerCase(Locale.ROOT).replaceAll("\\s+", " ").trim())) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY, "Resume validation failed: candidate name is missing from the generated document.");
        }
        Matcher emails = Pattern.compile("[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+", Pattern.CASE_INSENSITIVE).matcher(sourceText);
        while (emails.find()) if (!normalizedOutput.contains(emails.group().toLowerCase(Locale.ROOT))) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY, "Resume validation failed: an email address from the Master Resume is missing.");
        }
        Matcher phones = PHONE_PATTERN.matcher(sourceText);
        while (phones.find()) if (!normalizedOutput.contains(phones.group().replaceAll("\\s+", " ").toLowerCase(Locale.ROOT))) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY, "Resume validation failed: a phone number from the Master Resume is missing.");
        }
        Matcher links = LINK_PATTERN.matcher(sourceText);
        while (links.find()) {
            String link = links.group(2) != null ? links.group(2) : links.group(3);
            if (link != null && !normalizedOutput.contains(link.toLowerCase(Locale.ROOT))) {
                throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY, "Resume validation failed: a source link is missing.");
            }
        }
        Matcher years = Pattern.compile("\\b(?:19|20)\\d{2}\\b").matcher(sourceText);
        while (years.find()) if (!normalizedOutput.contains(years.group())) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY, "Resume validation failed: a source date is missing from the generated document.");
        }
        return "DOCX opened successfully; candidate identity, email and source years were preserved.";
    }

    byte[] editMasterTemplate(byte[] masterBytes, List<TemplateEdit> edits) throws Exception {
        if (masterBytes == null || masterBytes.length == 0) return null;
        if (edits == null || edits.isEmpty()) return masterBytes.clone();
        String masterText = extractDocumentText(masterBytes);
        try (XWPFDocument document = new XWPFDocument(new ByteArrayInputStream(masterBytes));
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            for (TemplateEdit edit : edits) {
                if (edit == null || edit.before() == null || edit.before().isBlank() || edit.after() == null) continue;
                if (Boolean.FALSE.equals(edit.safeToApply())) {
                    throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY, "A resume edit marked unsafe was rejected.");
                }
                List<String> evidence = edit.evidence() == null || edit.evidence().isEmpty()
                    ? List.of(edit.before()) : edit.evidence();
                ResumeTailoringValidator.Validation validation = ResumeTailoringValidator.validate(
                    masterText, masterText, "", edit.before(), edit.after(), evidence);
                if (!validation.valid()) throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                    "Resume edit rejected: " + validation.reason());
                List<XWPFParagraph> matches = allBodyParagraphs(document).stream()
                    .filter(paragraph -> paragraph.getText() != null
                        && locateNormalizedRange(paragraphTextFromRuns(paragraph), edit.before()) != null)
                    .toList();
                if (matches.size() != 1) {
                    throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY, matches.isEmpty()
                        ? "Resume edit could not be mapped to one original paragraph. No changes were applied."
                        : "Resume edit matched multiple original paragraphs. No changes were applied.");
                }
                applyParagraphRangeEdit(matches.get(0), edit.before(), edit.after());
            }
            document.write(output);
            return output.toByteArray();
        }
    }

    private void applyParagraphRangeEdit(XWPFParagraph paragraph, String before, String after) {
        List<XWPFRun> runs = paragraph.getRuns();
        StringBuilder combined = new StringBuilder();
        int[] starts = new int[runs.size()];
        for (int i = 0; i < runs.size(); i++) {
            starts[i] = combined.length();
            String text = Objects.toString(runs.get(i).text(), "");
            combined.append(text);
        }
        String paragraphText = combined.toString();
        int[] range = locateNormalizedRange(paragraphText, before);
        if (range == null) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                "Resume edit could not be mapped uniquely inside its original paragraph.");
        }
        int start = range[0];
        int end = range[1];
        int startRun = findRun(starts, runs, start, false);
        int endRun = findRun(starts, runs, end, true);
        if (startRun < 0 || endRun < 0) throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
            "Resume edit crossed unsupported document content and was not applied.");
        String firstText = Objects.toString(runs.get(startRun).text(), "");
        String prefix = firstText.substring(0, start - starts[startRun]);
        if (startRun == endRun) {
            String original = Objects.toString(runs.get(startRun).text(), "");
            int localEnd = end - starts[startRun];
            setRunTextPreservingProperties(runs.get(startRun), original.substring(0, start - starts[startRun])
                + after + original.substring(localEnd));
            return;
        }
        setRunTextPreservingProperties(runs.get(startRun), prefix + after);
        for (int i = startRun + 1; i < endRun; i++) setRunTextPreservingProperties(runs.get(i), "");
        String lastText = Objects.toString(runs.get(endRun).text(), "");
        int localEnd = end - starts[endRun];
        setRunTextPreservingProperties(runs.get(endRun), lastText.substring(Math.min(localEnd, lastText.length())));
    }

    private int findRun(int[] starts, List<XWPFRun> runs, int offset, boolean endBoundary) {
        for (int i = 0; i < runs.size(); i++) {
            int start = starts[i];
            int end = start + Objects.toString(runs.get(i).text(), "").length();
            if (offset >= start && (endBoundary ? offset <= end : offset < end)) return i;
        }
        return -1;
    }

    private void setRunTextPreservingProperties(XWPFRun run, String value) {
        List<org.openxmlformats.schemas.wordprocessingml.x2006.main.CTText> texts = run.getCTR().getTList();
        if (texts.isEmpty()) { run.setText(value); return; }
        texts.get(0).setStringValue(value);
        for (int i = 1; i < texts.size(); i++) texts.get(i).setStringValue("");
    }

    private String paragraphTextFromRuns(XWPFParagraph paragraph) {
        return paragraph.getRuns().stream().map(run -> Objects.toString(run.text(), "")).reduce("", String::concat);
    }

    /** Maps a whitespace-normalized excerpt back to exact character offsets in the original paragraph. */
    private int[] locateNormalizedRange(String source, String excerpt) {
        if (source == null || excerpt == null || excerpt.isBlank()) return null;
        StringBuilder normalized = new StringBuilder();
        List<Integer> rawStarts = new ArrayList<>();
        List<Integer> rawEnds = new ArrayList<>();
        for (int i = 0; i < source.length(); i++) {
            char current = source.charAt(i);
            if (Character.isWhitespace(current)) {
                if (normalized.length() == 0) continue;
                if (normalized.charAt(normalized.length() - 1) == ' ') rawEnds.set(rawEnds.size() - 1, i + 1);
                else { normalized.append(' '); rawStarts.add(i); rawEnds.add(i + 1); }
            } else {
                normalized.append(current); rawStarts.add(i); rawEnds.add(i + 1);
            }
        }
        if (normalized.length() > 0 && normalized.charAt(normalized.length() - 1) == ' ') {
            normalized.setLength(normalized.length() - 1); rawStarts.remove(rawStarts.size() - 1); rawEnds.remove(rawEnds.size() - 1);
        }
        String target = excerpt.replaceAll("\\s+", " ").trim();
        int index = normalized.indexOf(target);
        if (index < 0 || normalized.indexOf(target, index + 1) >= 0) return null;
        return new int[] { rawStarts.get(index), rawEnds.get(index + target.length() - 1) };
    }

    private String extractDocumentText(byte[] bytes) throws Exception {
        try (XWPFDocument document = new XWPFDocument(new ByteArrayInputStream(bytes))) {
            return String.join("\n", allDocumentParagraphs(document).stream()
                .map(XWPFParagraph::getText).filter(Objects::nonNull).toList());
        }
    }

    private List<XWPFParagraph> allDocumentParagraphs(XWPFDocument document) {
        List<XWPFParagraph> paragraphs = new ArrayList<>(allBodyParagraphs(document));
        for (XWPFHeader header : document.getHeaderList()) {
            paragraphs.addAll(header.getParagraphs());
            for (XWPFTable table : header.getTables()) addTableParagraphs(table, paragraphs);
        }
        for (XWPFFooter footer : document.getFooterList()) {
            paragraphs.addAll(footer.getParagraphs());
            for (XWPFTable table : footer.getTables()) addTableParagraphs(table, paragraphs);
        }
        return paragraphs;
    }

    private String documentStructureSignature(byte[] bytes) throws Exception {
        try (XWPFDocument document = new XWPFDocument(new ByteArrayInputStream(bytes))) {
            StringBuilder signature = new StringBuilder();
            for (IBodyElement element : document.getBodyElements()) {
                signature.append(element instanceof XWPFTable ? "TABLE" : "PARAGRAPH").append(';');
                if (element instanceof XWPFTable table) appendTableShape(table, signature);
            }
            if (document.getDocument().getBody().isSetSectPr()) signature.append(document.getDocument().getBody().getSectPr().xmlText());
            signature.append("|H:").append(document.getHeaderList().size()).append("|F:").append(document.getFooterList().size());
            for (XWPFHeader header : document.getHeaderList()) signature.append('|').append(header.getParagraphs().size()).append(':').append(header.getTables().size());
            for (XWPFFooter footer : document.getFooterList()) signature.append('|').append(footer.getParagraphs().size()).append(':').append(footer.getTables().size());
            return signature.toString();
        }
    }

    private void appendTableShape(XWPFTable table, StringBuilder target) {
        target.append('[').append(table.getRows().size()).append(':');
        for (XWPFTableRow row : table.getRows()) {
            target.append(row.getTableCells().size()).append(',');
            for (XWPFTableCell cell : row.getTableCells()) {
                target.append(cell.getParagraphs().size()).append('{');
                for (XWPFTable nested : cell.getTables()) appendTableShape(nested, target);
                target.append('}');
            }
        }
        target.append(']');
    }

    private List<XWPFParagraph> allBodyParagraphs(XWPFDocument document) {
        List<XWPFParagraph> paragraphs = new ArrayList<>();
        for (IBodyElement element : document.getBodyElements()) {
            if (element instanceof XWPFParagraph paragraph) paragraphs.add(paragraph);
            else if (element instanceof XWPFTable table) addTableParagraphs(table, paragraphs);
        }
        return paragraphs;
    }

    private void addTableParagraphs(XWPFTable table, List<XWPFParagraph> paragraphs) {
        for (XWPFTableRow row : table.getRows()) for (XWPFTableCell cell : row.getTableCells()) {
            paragraphs.addAll(cell.getParagraphs());
            for (XWPFTable nested : cell.getTables()) addTableParagraphs(nested, paragraphs);
        }
    }

}
