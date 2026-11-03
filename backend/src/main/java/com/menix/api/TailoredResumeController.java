package com.menix.api;

import org.apache.poi.xwpf.usermodel.*;
import org.apache.poi.wp.usermodel.HeaderFooterType;
import org.openxmlformats.schemas.wordprocessingml.x2006.main.*;
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
    public record TemplateEdit(String before, String after) {}
    public record TailoredDocxRequest(String resumeText, String jobDescription, String fullName,
                                      String masterDocxBase64, List<TemplateEdit> templateEdits) {}
    private record ResumeLine(String text, boolean entry) {}
    private record ResumeSection(String heading, List<ResumeLine> lines) {}
    private record ResumeData(String name, String contact, List<ResumeSection> sections) {}

    @PostMapping(value = "/tailor-docx", produces = DOCX_TYPE)
    public ResponseEntity<byte[]> tailorDocx(@RequestBody TailoredDocxRequest request) {
        if (request == null || request.resumeText() == null || request.resumeText().isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Master resume text is required.");
        }
        try {
            byte[] docx;
            boolean usedMasterTemplate = false;
            if (request.masterDocxBase64() != null && !request.masterDocxBase64().isBlank()) {
                byte[] source = Base64.getDecoder().decode(request.masterDocxBase64());
                docx = editMasterTemplate(source, request.templateEdits() == null ? List.of() : request.templateEdits());
                usedMasterTemplate = docx != null;
            } else docx = null;
            if (docx == null) {
                ResumeData resume = parseResume(request.resumeText(), request.fullName());
                docx = buildDocx(resume);
            }
            String validation = validateGeneratedDocx(docx, request.resumeText(), request.fullName());
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
            if (!usedMasterTemplate) response.header("X-Resume-Format-Note", "For the exact same format, upload your resume as DOCX.");
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
        String extracted;
        try (XWPFDocument document = new XWPFDocument(new ByteArrayInputStream(bytes))) {
            extracted = String.join("\n", allBodyParagraphs(document).stream().map(XWPFParagraph::getText).filter(Objects::nonNull).toList());
        }
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
        Matcher years = Pattern.compile("\\b(?:19|20)\\d{2}\\b").matcher(sourceText);
        while (years.find()) if (!normalizedOutput.contains(years.group())) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY, "Resume validation failed: a source date is missing from the generated document.");
        }
        return "DOCX opened successfully; candidate identity, email and source years were preserved.";
    }

    byte[] editMasterTemplate(byte[] masterBytes, List<TemplateEdit> edits) throws Exception {
        if (masterBytes == null || masterBytes.length == 0) return null;
        try (XWPFDocument document = new XWPFDocument(new ByteArrayInputStream(masterBytes));
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            for (TemplateEdit edit : edits) {
                if (edit == null || edit.before() == null || edit.before().isBlank() || edit.after() == null) continue;
                XWPFParagraph paragraph = allBodyParagraphs(document).stream()
                    .filter(p -> p.getText() != null && p.getText().contains(edit.before()))
                    .findFirst().orElse(null);
                if (paragraph == null) continue;
                String updated = paragraph.getText().replace(edit.before(), edit.after());
                replaceParagraphTextKeepingRuns(paragraph, updated);
            }
            document.write(output);
            return output.toByteArray();
        }
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

    private void replaceParagraphTextKeepingRuns(XWPFParagraph paragraph, String updated) {
        List<XWPFRun> runs = paragraph.getRuns();
        if (runs.isEmpty()) { paragraph.createRun().setText(updated); return; }
        int offset = 0;
        for (int i = 0; i < runs.size(); i++) {
            XWPFRun run = runs.get(i);
            int originalLength = run.text() == null ? 0 : run.text().length();
            int end = i == runs.size() - 1 ? updated.length() : Math.min(updated.length(), offset + originalLength);
            String piece = updated.substring(Math.min(offset, updated.length()), end);
            run.setText(piece, 0);
            offset = end;
        }
        // Existing run objects and their properties remain in place; paragraph structure is untouched.
    }

    private ResumeData parseResume(String source, String requestedName) {
        List<String> lines = Arrays.stream(source.replace("\r", "").split("\n"))
            .map(String::trim).filter(s -> !s.isBlank()).toList();
        if (lines.isEmpty()) throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY, "No readable resume content was found.");
        String name = requestedName == null || requestedName.isBlank() ? lines.get(0) : requestedName.trim();
        String contact = lines.size() > 1 && !isSectionHeading(lines.get(1)) ? lines.get(1) : "";
        List<ResumeSection> sections = new ArrayList<>();
        String currentHeading = "PROFILE";
        List<ResumeLine> currentLines = new ArrayList<>();
        int start = contact.isBlank() ? 1 : 2;
        for (int i = start; i < lines.size(); i++) {
            String line = lines.get(i);
            if (isSectionHeading(line)) {
                if (!currentLines.isEmpty()) sections.add(new ResumeSection(currentHeading, currentLines));
                currentHeading = normalizeHeading(line);
                currentLines = new ArrayList<>();
            } else {
                currentLines.add(new ResumeLine(line, isEntryLine(line, currentHeading)));
            }
        }
        if (!currentLines.isEmpty()) sections.add(new ResumeSection(currentHeading, currentLines));
        return new ResumeData(name, contact, sections);
    }

    private boolean isSectionHeading(String line) {
        String h = line.trim().replaceAll("[:：]$", "").toUpperCase(Locale.ROOT);
        return Set.of("SUMMARY", "PROFILE", "PROFESSIONAL SUMMARY", "OBJECTIVE", "SKILLS", "TECHNICAL SKILLS",
            "CORE COMPETENCIES", "EXPERIENCE", "WORK EXPERIENCE", "PROFESSIONAL EXPERIENCE", "INTERNSHIPS",
            "PROJECTS", "PERSONAL PROJECTS", "EDUCATION", "CERTIFICATIONS", "CERTIFICATES", "ACHIEVEMENTS",
            "AWARDS", "PUBLICATIONS", "LANGUAGES", "VOLUNTEERING", "ADDITIONAL INFORMATION", "COURSEWORK").contains(h);
    }

    private String normalizeHeading(String heading) {
        String h = heading.trim().replaceAll("[:：]$", "").toUpperCase(Locale.ROOT);
        return switch (h) {
            case "PROFILE", "OBJECTIVE" -> "PROFESSIONAL SUMMARY";
            case "TECHNICAL SKILLS", "CORE COMPETENCIES" -> "SKILLS";
            case "WORK EXPERIENCE", "PROFESSIONAL EXPERIENCE", "INTERNSHIPS" -> "EXPERIENCE";
            case "PERSONAL PROJECTS" -> "PROJECTS";
            case "CERTIFICATES" -> "CERTIFICATIONS";
            default -> h;
        };
    }

    private boolean isEntryLine(String line, String heading) {
        return ("EXPERIENCE".equals(heading) || "PROJECTS".equals(heading) || "EDUCATION".equals(heading))
            && (line.contains("\t") || line.matches(".*\\b(19|20)\\d{2}\\b.*"));
    }

    private byte[] buildDocx(ResumeData resume) throws Exception {
        try (XWPFDocument doc = new XWPFDocument(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            CTSectPr sectPr = doc.getDocument().getBody().isSetSectPr()
                ? doc.getDocument().getBody().getSectPr() : doc.getDocument().getBody().addNewSectPr();
            CTPageMar margins = sectPr.isSetPgMar() ? sectPr.getPgMar() : sectPr.addNewPgMar();
            margins.setTop(720); margins.setBottom(720); margins.setLeft(850); margins.setRight(850);

            XWPFParagraph nameP = doc.createParagraph();
            nameP.setAlignment(ParagraphAlignment.CENTER); nameP.setSpacingAfter(35); nameP.setKeepNext(true);
            XWPFRun nameRun = nameP.createRun(); nameRun.setText(resume.name()); nameRun.setBold(true);
            nameRun.setFontFamily("Aptos Display"); nameRun.setFontSize(21); nameRun.setColor("163A63");

            if (!resume.contact().isBlank()) {
                XWPFParagraph contactP = doc.createParagraph(); contactP.setAlignment(ParagraphAlignment.CENTER);
                contactP.setSpacingAfter(130); contactP.setKeepNext(true);
                addTextWithLinks(doc, contactP, resume.contact(), "Aptos", 8, "475569", false);
            }

            for (ResumeSection section : resume.sections()) {
                if (section.lines().isEmpty()) continue;
                addSectionHeading(doc, section.heading());
                for (ResumeLine line : section.lines()) {
                    String text = line.text();
                    if (line.entry()) addEntryLine(doc, text);
                    else if (looksLikeBullet(text) || "EXPERIENCE".equals(section.heading()) || "PROJECTS".equals(section.heading()))
                        addBullet(doc, cleanBullet(text));
                    else if ("SKILLS".equals(section.heading()) && text.contains(":")) addSkillLine(doc, text);
                    else addBodyLine(doc, text);
                }
            }
            addPageNumberFooter(doc);
            doc.write(out);
            return out.toByteArray();
        }
    }

    private void addSectionHeading(XWPFDocument doc, String heading) {
        XWPFParagraph p = doc.createParagraph(); p.setSpacingBefore(135); p.setSpacingAfter(55); p.setKeepNext(true);
        CTPPr paragraphProperties = p.getCTP().getPPr();
        if (paragraphProperties == null) paragraphProperties = p.getCTP().addNewPPr();
        CTPBdr borders = paragraphProperties.isSetPBdr() ? paragraphProperties.getPBdr() : paragraphProperties.addNewPBdr();
        CTBorder bottomBorder = borders.isSetBottom() ? borders.getBottom() : borders.addNewBottom();
        bottomBorder.setVal(STBorder.SINGLE);
        bottomBorder.setSz(java.math.BigInteger.valueOf(6));
        bottomBorder.setColor("CBD5E1");
        XWPFRun r = p.createRun(); r.setText(heading); r.setBold(true); r.setFontFamily("Aptos");
        r.setFontSize(10); r.setColor("1D4ED8");
    }

    private void addEntryLine(XWPFDocument doc, String text) {
        String[] parts = text.split("\\t+");
        XWPFParagraph p = doc.createParagraph(); p.setSpacingBefore(65); p.setSpacingAfter(25); p.setKeepNext(true);
        addTextWithLinks(doc, p, parts[0].trim(), "Aptos", 9, "172B4D", true);
        for (int i = 1; i < parts.length; i++) {
            addTextWithLinks(doc, p, "  |  " + parts[i].trim(), "Aptos", 8, "475569", false);
        }
    }

    private void addSkillLine(XWPFDocument doc, String text) {
        int colon = text.indexOf(':'); XWPFParagraph p = doc.createParagraph(); p.setSpacingAfter(35);
        XWPFRun label = p.createRun(); label.setText(text.substring(0, colon + 1) + " "); label.setBold(true);
        label.setFontFamily("Aptos"); label.setFontSize(8.7); label.setColor("172B4D");
        addTextWithLinks(doc, p, text.substring(colon + 1).trim(), "Aptos", 8.7, "334155", false);
    }

    private void addBodyLine(XWPFDocument doc, String text) {
        XWPFParagraph p = doc.createParagraph(); p.setSpacingAfter(45); p.setSpacingBetween(1.05);
        addTextWithLinks(doc, p, text, "Aptos", 9, "263445", false);
    }

    private void addBullet(XWPFDocument doc, String text) {
        XWPFParagraph p = doc.createParagraph(); p.setIndentationLeft(260); p.setFirstLineIndent(-150);
        p.setSpacingAfter(40); p.setSpacingBetween(1.03);
        XWPFRun bullet = p.createRun(); bullet.setText("•  "); bullet.setFontFamily("Aptos"); bullet.setFontSize(9); bullet.setColor("1D4ED8");
        addTextWithLinks(doc, p, text, "Aptos", 9, "263445", false);
    }

    private void addTextWithLinks(XWPFDocument doc, XWPFParagraph paragraph, String text,
                                  String font, double size, String color, boolean bold) {
        Matcher matcher = LINK_PATTERN.matcher(text);
        int cursor = 0;
        while (matcher.find()) {
            if (matcher.start() > cursor) {
                addFormattedRun(paragraph.createRun(), text.substring(cursor, matcher.start()), font, size, color, bold);
            }
            String label = matcher.group(1);
            String url = matcher.group(2);
            if (url == null) {
                label = matcher.group(3);
                url = label;
            }
            XWPFHyperlinkRun hyperlinkRun = paragraph.createHyperlinkRun(url);
            hyperlinkRun.setText(label);
            addFormattedRun(hyperlinkRun, label, font, size, "0563C1", bold);
            cursor = matcher.end();
        }
        if (cursor < text.length()) {
            addFormattedRun(paragraph.createRun(), text.substring(cursor), font, size, color, bold);
        }
    }

    private void addFormattedRun(XWPFRun run, String text, String font, double size, String color, boolean bold) {
        run.setText(text);
        run.setFontFamily(font);
        run.setFontSize(size);
        run.setColor(color);
        run.setBold(bold);
        if (run instanceof XWPFHyperlinkRun) run.setUnderline(UnderlinePatterns.SINGLE);
    }

    private boolean looksLikeBullet(String text) {
        return text.startsWith("•") || text.startsWith("·") || text.startsWith("- ") || text.startsWith("– ");
    }

    private String cleanBullet(String text) {
        return text.replaceFirst("^[•·]\\s*", "").replaceFirst("^[-–]\\s*", "").trim();
    }

    private void addPageNumberFooter(XWPFDocument doc) {
        XWPFFooter footer = doc.createFooter(HeaderFooterType.DEFAULT);
        List<XWPFParagraph> paragraphs = footer.getParagraphs();
        XWPFParagraph p = paragraphs.isEmpty() ? footer.createParagraph() : paragraphs.get(0);
        p.setAlignment(ParagraphAlignment.CENTER);
        XWPFRun r = p.createRun(); r.setFontFamily("Aptos"); r.setFontSize(8); r.setColor("64748B"); r.setText("Page ");
        r.getCTR().addNewFldChar().setFldCharType(STFldCharType.BEGIN);
        r = p.createRun(); r.getCTR().addNewInstrText().setStringValue(" PAGE ");
        r = p.createRun(); r.getCTR().addNewFldChar().setFldCharType(STFldCharType.END);
    }
}
