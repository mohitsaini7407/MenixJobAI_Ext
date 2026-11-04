package com.menix.service;

import com.menix.model.DocxEditOperation;
import com.menix.model.DocxTailoringReport;
import org.apache.poi.xwpf.usermodel.XWPFDocument;
import org.apache.poi.xwpf.usermodel.XWPFParagraph;
import org.apache.poi.xwpf.usermodel.XWPFRun;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class DocxTailoringEngineTest {

    private byte[] sampleDocx;

    @BeforeEach
    void setUp() throws Exception {
        try (XWPFDocument doc = new XWPFDocument(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            // Paragraph 0: Name
            XWPFParagraph p0 = doc.createParagraph();
            XWPFRun r0 = p0.createRun();
            r0.setText("MOHIT BANASYA");
            r0.setBold(true);
            r0.setFontSize(16);

            // Paragraph 1: Languages with bold label
            XWPFParagraph p1 = doc.createParagraph();
            XWPFRun r1a = p1.createRun();
            r1a.setText("Languages: ");
            r1a.setBold(true);
            r1a.setFontFamily("Calibri");
            XWPFRun r1b = p1.createRun();
            r1b.setText("JavaScript, Python, SQL, C++");
            r1b.setBold(false);
            r1b.setFontFamily("Calibri");

            // Paragraph 2: Summary bullet
            XWPFParagraph p2 = doc.createParagraph();
            XWPFRun r2 = p2.createRun();
            r2.setText("Full Stack Developer with experience in React and Node.js.");
            r2.setFontFamily("Calibri");

            doc.write(out);
            sampleDocx = out.toByteArray();
        }
    }

    @Test
    @DisplayName("Run-level span replacement preserves bold label and surrounding styles")
    void testPreservesBoldLabelOnSpanReplacement() throws Exception {
        DocxEditOperation edit = new DocxEditOperation(
                "edit-1", "p-1", "replace_span",
                "JavaScript, Python, SQL, C++",
                "Python, JavaScript, TypeScript, SQL",
                "Highlight Python first for SWE Trainee role",
                List.of("req-python", "req-ts"),
                "low",
                false
        );

        DocxTailoringEngine.TailoringResult result = DocxTailoringEngine.applyEdits(sampleDocx, List.of(edit));
        assertNotNull(result.docxBytes());
        assertTrue(result.report().textChanged());
        assertEquals(1, result.report().applied().size());
        assertEquals(0, result.report().skipped().size());

        // Verify runs in output
        try (XWPFDocument doc = new XWPFDocument(new ByteArrayInputStream(result.docxBytes()))) {
            XWPFParagraph p1 = doc.getParagraphs().get(1);
            assertEquals("Languages: Python, JavaScript, TypeScript, SQL", p1.getText());
            // First run must still be bold "Languages: "
            assertTrue(p1.getRuns().get(0).isBold());
            assertEquals("Languages: ", p1.getRuns().get(0).text());
            // Second run must be the new regular skills list
            assertFalse(p1.getRuns().get(1).isBold());
            assertTrue(p1.getRuns().get(1).text().contains("Python, JavaScript, TypeScript, SQL"));
        }
    }

    @Test
    @DisplayName("Fail loudly: throws DocxTailoringException if no edits can be applied")
    void testFailsLoudlyWhenNoEditsMatch() {
        DocxEditOperation nonExistentEdit = new DocxEditOperation(
                "edit-404", "p-99", "replace_span",
                "Non-existent text that is nowhere in resume",
                "Some other text",
                "Unmatched edit",
                List.of(),
                "high",
                false
        );

        DocxTailoringEngine.DocxTailoringException ex = assertThrows(
                DocxTailoringEngine.DocxTailoringException.class,
                () -> DocxTailoringEngine.applyEdits(sampleDocx, List.of(nonExistentEdit))
        );
        assertTrue(ex.getMessage().contains("None of the 1 proposed edits could be safely mapped"));
    }

    @Test
    @DisplayName("Fail loudly: throws DocxTailoringException if text has not changed")
    void testFailsLoudlyWhenTextUnchanged() {
        DocxEditOperation noOpEdit = new DocxEditOperation(
                "edit-noop", "p-0", "replace_span",
                "MOHIT BANASYA",
                "MOHIT BANASYA",
                "Identity replacement",
                List.of(),
                "low",
                false
        );

        DocxTailoringEngine.DocxTailoringException ex = assertThrows(
                DocxTailoringEngine.DocxTailoringException.class,
                () -> DocxTailoringEngine.applyEdits(sampleDocx, List.of(noOpEdit))
        );
        assertTrue(ex.getMessage().contains("identical to the master document"));
    }

    @Test
    @DisplayName("Paragraph index generation returns accurate IDs and run structures")
    void testIndexDocumentStructure() throws Exception {
        List<DocxTailoringEngine.IndexedParagraph> index = DocxTailoringEngine.indexDocument(sampleDocx);
        assertEquals(3, index.size());
        assertEquals("p-0", index.get(0).id());
        assertEquals("MOHIT BANASYA", index.get(0).rawText());
        assertEquals("p-1", index.get(1).id());
        assertEquals(2, index.get(1).runs().size());
        assertTrue(index.get(1).runs().get(0).isBold());
    }
}

