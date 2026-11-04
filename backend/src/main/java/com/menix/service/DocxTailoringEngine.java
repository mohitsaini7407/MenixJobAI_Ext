package com.menix.service;

import com.menix.model.DocxEditOperation;
import com.menix.model.DocxTailoringReport;
import com.menix.model.DocxTailoringReport.AppliedEdit;
import com.menix.model.DocxTailoringReport.SkippedEdit;
import org.apache.poi.xwpf.usermodel.*;
import org.openxmlformats.schemas.wordprocessingml.x2006.main.CTPageMar;
import org.openxmlformats.schemas.wordprocessingml.x2006.main.CTText;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.*;

public final class DocxTailoringEngine {

    public static class DocxTailoringException extends RuntimeException {
        public DocxTailoringException(String message) {
            super(message);
        }
    }

    public record TailoringResult(
        byte[] docxBytes,
        DocxTailoringReport report
    ) {}

    public record IndexedParagraph(
        String id,
        int index,
        XWPFParagraph paragraph,
        String rawText,
        String normalizedText,
        List<RunMeta> runs
    ) {}

    public record RunMeta(
        int index,
        XWPFRun run,
        String text,
        boolean isBold,
        boolean isItalic,
        String fontFamily,
        int fontSize
    ) {}

    /**
     * Extracts a structured paragraph index of the master DOCX to send to models or UI.
     */
    public static List<IndexedParagraph> indexDocument(byte[] docxBytes) throws IOException {
        try (XWPFDocument doc = new XWPFDocument(new ByteArrayInputStream(docxBytes))) {
            return indexParagraphs(doc);
        }
    }

    public static List<IndexedParagraph> indexParagraphs(XWPFDocument document) {
        List<IndexedParagraph> indexed = new ArrayList<>();
        List<XWPFParagraph> paragraphs = allBodyParagraphs(document);
        for (int i = 0; i < paragraphs.size(); i++) {
            XWPFParagraph p = paragraphs.get(i);
            String raw = paragraphTextFromRuns(p);
            String norm = normalizeText(raw);
            List<RunMeta> runMetas = new ArrayList<>();
            List<XWPFRun> runs = p.getRuns();
            for (int r = 0; r < runs.size(); r++) {
                XWPFRun run = runs.get(r);
                runMetas.add(new RunMeta(
                    r, run, Objects.toString(run.text(), ""),
                    run.isBold(), run.isItalic(),
                    run.getFontFamily(), run.getFontSize()
                ));
            }
            indexed.add(new IndexedParagraph("p-" + i, i, p, raw, norm, runMetas));
        }
        return indexed;
    }

    /**
     * Applies structured edit operations at run-level in-place and verifies results.
     * Fails loudly if no edits are applied or text has not changed.
     */
    public static TailoringResult applyEdits(byte[] masterBytes, List<DocxEditOperation> edits) throws Exception {
        if (masterBytes == null || masterBytes.length == 0) {
            throw new DocxTailoringException("Master DOCX file is empty.");
        }
        if (edits == null || edits.isEmpty()) {
            throw new DocxTailoringException("No edits were provided to tailor the resume.");
        }

        String masterFullText;
        int estimatedPageCountBefore;
        try (XWPFDocument masterDoc = new XWPFDocument(new ByteArrayInputStream(masterBytes))) {
            masterFullText = extractDocumentText(masterDoc);
            estimatedPageCountBefore = estimatePageCount(masterDoc);
        }

        List<AppliedEdit> appliedList = new ArrayList<>();
        List<SkippedEdit> skippedList = new ArrayList<>();

        byte[] outputBytes;
        try (XWPFDocument document = new XWPFDocument(new ByteArrayInputStream(masterBytes));
             ByteArrayOutputStream out = new ByteArrayOutputStream()) {

            List<IndexedParagraph> indexedParagraphs = indexParagraphs(document);

            for (DocxEditOperation edit : edits) {
                if (edit == null || edit.before() == null || edit.before().isBlank() || edit.after() == null) {
                    skippedList.add(new SkippedEdit(edit == null ? "unknown" : edit.editId(), "Edit before/after content is empty."));
                    continue;
                }

                IndexedParagraph target = findTargetParagraph(indexedParagraphs, edit);
                if (target == null) {
                    skippedList.add(new SkippedEdit(edit.editId(),
                        "Could not locate target paragraph for text: \"" + truncate(edit.before(), 40) + "\""));
                    continue;
                }

                boolean success = applyRunLevelEdit(target.paragraph(), edit);
                if (success) {
                    appliedList.add(new AppliedEdit(
                        edit.editId(), target.id(), edit.op(), edit.before(), edit.after(), edit.reason()
                    ));
                } else {
                    skippedList.add(new SkippedEdit(edit.editId(),
                        "Run-level mapping failed inside paragraph: \"" + truncate(target.rawText(), 40) + "\""));
                }
            }

            document.write(out);
            outputBytes = out.toByteArray();
        }

        // --- VERIFICATION (Fail Loudly) ---
        if (appliedList.isEmpty()) {
            throw new DocxTailoringException(
                "None of the " + edits.size() + " proposed edits could be safely mapped into the master DOCX. No file was generated."
            );
        }

        String tailoredFullText;
        int estimatedPageCountAfter;
        boolean fontsIntact;
        boolean marginsIntact;
        try (XWPFDocument verifyDoc = new XWPFDocument(new ByteArrayInputStream(outputBytes));
             XWPFDocument masterDoc = new XWPFDocument(new ByteArrayInputStream(masterBytes))) {

            tailoredFullText = extractDocumentText(verifyDoc);
            estimatedPageCountAfter = estimatePageCount(verifyDoc);
            fontsIntact = verifyFontsUnchanged(masterDoc, verifyDoc);
            marginsIntact = verifyMarginsUnchanged(masterDoc, verifyDoc);

            // Verify every applied edit's "after" text is actually in the output
            for (AppliedEdit applied : appliedList) {
                String normalizedAfter = normalizeText(applied.after());
                String normalizedDoc = normalizeText(tailoredFullText);
                if (!normalizedDoc.contains(normalizedAfter)) {
                    throw new DocxTailoringException(
                        "Verification failed: applied text \"" + truncate(applied.after(), 40) + "\" was missing in the output document."
                    );
                }
            }
        }

        boolean textChanged = !normalizeText(masterFullText).equals(normalizeText(tailoredFullText));
        if (!textChanged) {
            throw new DocxTailoringException(
                "Document verification failed: The generated DOCX is identical to the master document. No file was generated."
            );
        }

        DocxTailoringReport report = new DocxTailoringReport(
            appliedList,
            skippedList,
            textChanged,
            estimatedPageCountBefore,
            estimatedPageCountAfter,
            fontsIntact,
            marginsIntact,
            String.format(Locale.ROOT, "Applied %d edits, skipped %d. Page count: %d -> %d.",
                appliedList.size(), skippedList.size(), estimatedPageCountBefore, estimatedPageCountAfter)
        );

        return new TailoringResult(outputBytes, report);
    }

    private static IndexedParagraph findTargetParagraph(List<IndexedParagraph> list, DocxEditOperation edit) {
        // Strategy 1: Match by paragraphId
        if (edit.paragraphId() != null && !edit.paragraphId().isBlank()) {
            for (IndexedParagraph p : list) {
                if (p.id().equalsIgnoreCase(edit.paragraphId().trim())) {
                    if (containsSubstringNormalized(p.rawText(), edit.before())) {
                        return p;
                    }
                }
            }
        }

        // Strategy 2: Match by exact before text
        List<IndexedParagraph> exactMatches = new ArrayList<>();
        for (IndexedParagraph p : list) {
            if (p.rawText().contains(edit.before())) {
                exactMatches.add(p);
            }
        }
        if (exactMatches.size() == 1) return exactMatches.get(0);
        if (exactMatches.size() > 1) return null; // Ambiguous

        // Strategy 3: Match by normalized before text
        List<IndexedParagraph> normMatches = new ArrayList<>();
        String targetNorm = normalizeText(edit.before());
        for (IndexedParagraph p : list) {
            if (p.normalizedText().contains(targetNorm)) {
                normMatches.add(p);
            }
        }
        if (normMatches.size() == 1) return normMatches.get(0);
        if (normMatches.size() > 1) return null; // Ambiguous

        // Strategy 4: Fuzzy token overlap match (similarity >= 0.85)
        IndexedParagraph best = null;
        double highestSimilarity = 0.85;
        for (IndexedParagraph p : list) {
            double sim = calculateTokenSimilarity(p.normalizedText(), targetNorm);
            if (sim > highestSimilarity) {
                highestSimilarity = sim;
                best = p;
            }
        }
        return best;
    }

    private static boolean applyRunLevelEdit(XWPFParagraph paragraph, DocxEditOperation edit) {
        String before = edit.before();
        String after = edit.after();
        List<XWPFRun> runs = paragraph.getRuns();
        if (runs.isEmpty()) {
            XWPFRun newRun = paragraph.createRun();
            newRun.setText(after);
            return true;
        }

        // If replace_paragraph or entire paragraph text matches before
        if ("replace_paragraph".equalsIgnoreCase(edit.op()) || normalizeText(paragraphTextFromRuns(paragraph)).equals(normalizeText(before))) {
            // Keep first run's font/bold style and replace text, clear other runs
            setRunTextPreservingProperties(runs.get(0), after);
            for (int i = 1; i < runs.size(); i++) {
                setRunTextPreservingProperties(runs.get(i), "");
            }
            return true;
        }

        // Span-level run replacement: find which run(s) contain the target span
        StringBuilder combined = new StringBuilder();
        int[] starts = new int[runs.size()];
        for (int i = 0; i < runs.size(); i++) {
            starts[i] = combined.length();
            combined.append(Objects.toString(runs.get(i).text(), ""));
        }
        String fullParaText = combined.toString();

        int[] range = locateRange(fullParaText, before);
        if (range == null) {
            range = locateNormalizedRange(fullParaText, before);
        }
        if (range == null) return false;

        int start = range[0];
        int end = range[1];

        int startRun = findRunIndex(starts, runs, start, false);
        int endRun = findRunIndex(starts, runs, end, true);
        if (startRun < 0 || endRun < 0) return false;

        String firstRunText = Objects.toString(runs.get(startRun).text(), "");
        int localStart = start - starts[startRun];
        String prefix = firstRunText.substring(0, Math.min(localStart, firstRunText.length()));

        if (startRun == endRun) {
            int localEnd = end - starts[startRun];
            String suffix = firstRunText.substring(Math.min(localEnd, firstRunText.length()));
            setRunTextPreservingProperties(runs.get(startRun), prefix + after + suffix);
            return true;
        }

        // Multi-run span: modify start run with prefix + after
        setRunTextPreservingProperties(runs.get(startRun), prefix + after);
        // Clear intermediate runs
        for (int i = startRun + 1; i < endRun; i++) {
            setRunTextPreservingProperties(runs.get(i), "");
        }
        // Modify end run to keep only suffix
        String lastRunText = Objects.toString(runs.get(endRun).text(), "");
        int localEnd = end - starts[endRun];
        String suffix = lastRunText.substring(Math.min(localEnd, lastRunText.length()));
        setRunTextPreservingProperties(runs.get(endRun), suffix);
        return true;
    }

    private static int findRunIndex(int[] starts, List<XWPFRun> runs, int offset, boolean isEnd) {
        for (int i = 0; i < runs.size(); i++) {
            int s = starts[i];
            int e = s + Objects.toString(runs.get(i).text(), "").length();
            if (offset >= s && (isEnd ? offset <= e : offset < e)) return i;
        }
        return -1;
    }

    private static void setRunTextPreservingProperties(XWPFRun run, String value) {
        List<CTText> texts = run.getCTR().getTList();
        if (texts.isEmpty()) {
            run.setText(value);
            return;
        }
        texts.get(0).setStringValue(value);
        for (int i = 1; i < texts.size(); i++) {
            texts.get(i).setStringValue("");
        }
    }

    private static int[] locateRange(String source, String target) {
        int idx = source.indexOf(target);
        if (idx >= 0) return new int[]{idx, idx + target.length()};
        idx = source.toLowerCase(Locale.ROOT).indexOf(target.toLowerCase(Locale.ROOT));
        if (idx >= 0) return new int[]{idx, idx + target.length()};
        return null;
    }

    private static int[] locateNormalizedRange(String source, String excerpt) {
        if (source == null || excerpt == null || excerpt.isBlank()) return null;
        StringBuilder normSource = new StringBuilder();
        List<Integer> rawStarts = new ArrayList<>();
        List<Integer> rawEnds = new ArrayList<>();
        for (int i = 0; i < source.length(); i++) {
            char c = source.charAt(i);
            if (Character.isWhitespace(c)) {
                if (normSource.length() == 0 || normSource.charAt(normSource.length() - 1) == ' ') continue;
                normSource.append(' ');
                rawStarts.add(i);
                rawEnds.add(i + 1);
            } else {
                normSource.append(Character.toLowerCase(c));
                rawStarts.add(i);
                rawEnds.add(i + 1);
            }
        }

        String normExcerpt = normalizeText(excerpt);
        int matchIdx = normSource.indexOf(normExcerpt);
        if (matchIdx < 0 || rawStarts.isEmpty()) return null;

        int rawStart = rawStarts.get(matchIdx);
        int rawEnd = rawEnds.get(Math.min(matchIdx + normExcerpt.length() - 1, rawEnds.size() - 1));
        return new int[]{rawStart, rawEnd};
    }

    private static boolean containsSubstringNormalized(String source, String target) {
        return normalizeText(source).contains(normalizeText(target));
    }

    private static double calculateTokenSimilarity(String a, String b) {
        Set<String> setA = new HashSet<>(Arrays.asList(a.split("\\s+")));
        Set<String> setB = new HashSet<>(Arrays.asList(b.split("\\s+")));
        if (setA.isEmpty() || setB.isEmpty()) return 0.0;
        int intersection = 0;
        for (String t : setA) {
            if (setB.contains(t)) intersection++;
        }
        return (2.0 * intersection) / (setA.size() + setB.size());
    }

    private static String extractDocumentText(XWPFDocument doc) {
        StringBuilder sb = new StringBuilder();
        for (XWPFParagraph p : allBodyParagraphs(doc)) {
            sb.append(paragraphTextFromRuns(p)).append("\n");
        }
        return sb.toString();
    }

    private static List<XWPFParagraph> allBodyParagraphs(XWPFDocument document) {
        List<XWPFParagraph> list = new ArrayList<>(document.getParagraphs());
        for (XWPFTable table : document.getTables()) {
            for (XWPFTableRow row : table.getRows()) {
                for (XWPFTableCell cell : row.getTableCells()) {
                    list.addAll(cell.getParagraphs());
                }
            }
        }
        return list;
    }

    private static String paragraphTextFromRuns(XWPFParagraph p) {
        StringBuilder sb = new StringBuilder();
        for (XWPFRun r : p.getRuns()) {
            sb.append(Objects.toString(r.text(), ""));
        }
        return sb.toString();
    }

    private static int estimatePageCount(XWPFDocument doc) {
        // Line based estimate: roughly 45 lines per page for typical standard margins
        int lines = 0;
        for (XWPFParagraph p : allBodyParagraphs(doc)) {
            String text = paragraphTextFromRuns(p).trim();
            if (text.isEmpty()) continue;
            lines += Math.max(1, (int) Math.ceil(text.length() / 85.0));
        }
        return Math.max(1, (int) Math.ceil(lines / 45.0));
    }

    private static boolean verifyFontsUnchanged(XWPFDocument before, XWPFDocument after) {
        Set<String> fontsBefore = collectFonts(before);
        Set<String> fontsAfter = collectFonts(after);
        return fontsAfter.containsAll(fontsBefore);
    }

    private static Set<String> collectFonts(XWPFDocument doc) {
        Set<String> fonts = new HashSet<>();
        for (XWPFParagraph p : allBodyParagraphs(doc)) {
            for (XWPFRun r : p.getRuns()) {
                if (r.getFontFamily() != null) fonts.add(r.getFontFamily());
            }
        }
        return fonts;
    }

    private static boolean verifyMarginsUnchanged(XWPFDocument before, XWPFDocument after) {
        CTPageMar marBefore = getMargins(before);
        CTPageMar marAfter = getMargins(after);
        if (marBefore == null || marAfter == null) return true;
        return Objects.equals(marBefore.getTop(), marAfter.getTop())
            && Objects.equals(marBefore.getBottom(), marAfter.getBottom())
            && Objects.equals(marBefore.getLeft(), marAfter.getLeft())
            && Objects.equals(marBefore.getRight(), marAfter.getRight());
    }

    private static CTPageMar getMargins(XWPFDocument doc) {
        try {
            return doc.getDocument().getBody().getSectPr().getPgMar();
        } catch (Exception e) {
            return null;
        }
    }

    private static String normalizeText(String value) {
        if (value == null) return "";
        return value.replace('\u00A0', ' ')
            .replace('“', '"').replace('”', '"')
            .replace('‘', '\'').replace('’', '\'')
            .replace('—', '-').replace('–', '-')
            .replaceAll("\\s+", " ")
            .trim()
            .toLowerCase(Locale.ROOT);
    }

    private static String truncate(String text, int max) {
        if (text == null) return "";
        return text.length() <= max ? text : text.substring(0, max - 3) + "...";
    }
}
