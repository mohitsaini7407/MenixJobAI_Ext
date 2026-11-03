package com.menix.api;

import org.apache.poi.xwpf.usermodel.*;
import org.junit.jupiter.api.Test;
import org.openxmlformats.schemas.wordprocessingml.x2006.main.CTPageMar;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class TailoredResumeTemplateTest {
    @Test
    void editedTemplateKeepsFormattingMarginsAndSectionHeadings() throws Exception {
        byte[] masterBytes;
        try (XWPFDocument master = new XWPFDocument(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            XWPFParagraph heading = master.createParagraph();
            XWPFRun headingRun = heading.createRun(); headingRun.setText("PROFESSIONAL EXPERIENCE");
            headingRun.setFontFamily("Georgia"); headingRun.setFontSize(15);
            XWPFParagraph body = master.createParagraph();
            XWPFRun first = body.createRun(); first.setText("Experienced "); first.setFontFamily("Georgia"); first.setFontSize(10);
            XWPFRun second = body.createRun(); second.setText("Java engineer"); second.setFontFamily("Arial"); second.setFontSize(9);
            CTPageMar margins = master.getDocument().getBody().addNewSectPr().addNewPgMar();
            margins.setTop(720); margins.setBottom(760); margins.setLeft(800); margins.setRight(800);
            master.write(output); masterBytes = output.toByteArray();
        }

        byte[] tailored = new TailoredResumeController().editMasterTemplate(masterBytes,
            List.of(new TailoredResumeController.TemplateEdit("Java engineer", "Java developer")));

        try (XWPFDocument original = new XWPFDocument(new ByteArrayInputStream(masterBytes));
             XWPFDocument result = new XWPFDocument(new ByteArrayInputStream(tailored))) {
            assertEquals(original.getParagraphs().size(), result.getParagraphs().size());
            assertEquals("PROFESSIONAL EXPERIENCE", result.getParagraphs().get(0).getText());
            assertEquals(original.getParagraphs().get(0).getRuns().get(0).getFontFamily(), result.getParagraphs().get(0).getRuns().get(0).getFontFamily());
            assertEquals(original.getParagraphs().get(0).getRuns().get(0).getFontSize(), result.getParagraphs().get(0).getRuns().get(0).getFontSize());
            assertTrue(result.getParagraphs().get(1).getText().contains("Java developer"));
            assertEquals(original.getParagraphs().get(1).getRuns().get(0).getFontFamily(), result.getParagraphs().get(1).getRuns().get(0).getFontFamily());
            assertEquals(original.getParagraphs().get(1).getRuns().get(1).getFontFamily(), result.getParagraphs().get(1).getRuns().get(1).getFontFamily());
            assertEquals(original.getParagraphs().get(1).getRuns().get(0).getFontSize(), result.getParagraphs().get(1).getRuns().get(0).getFontSize());
            assertEquals(original.getParagraphs().get(1).getRuns().get(1).getFontSize(), result.getParagraphs().get(1).getRuns().get(1).getFontSize());
            CTPageMar before = original.getDocument().getBody().getSectPr().getPgMar();
            CTPageMar after = result.getDocument().getBody().getSectPr().getPgMar();
            assertEquals(before.getTop(), after.getTop()); assertEquals(before.getBottom(), after.getBottom());
            assertEquals(before.getLeft(), after.getLeft()); assertEquals(before.getRight(), after.getRight());
        }
    }

    @Test
    void replacementAcrossRunsKeepsBothRunStylesAndUneditedSuffix() throws Exception {
        byte[] masterBytes;
        try (XWPFDocument master = new XWPFDocument(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            XWPFParagraph body = master.createParagraph();
            XWPFRun first = body.createRun(); first.setText("Built a "); first.setFontFamily("Georgia"); first.setBold(true);
            XWPFRun second = body.createRun(); second.setText("Java service"); second.setFontFamily("Arial"); second.setItalic(true);
            XWPFRun third = body.createRun(); third.setText(" for internal tools."); third.setFontFamily("Courier New");
            master.write(output); masterBytes = output.toByteArray();
        }

        byte[] tailored = new TailoredResumeController().editMasterTemplate(masterBytes,
            List.of(new TailoredResumeController.TemplateEdit("Java service", "Java application service")));

        try (XWPFDocument result = new XWPFDocument(new ByteArrayInputStream(tailored))) {
            XWPFParagraph paragraph = result.getParagraphs().get(0);
            assertEquals("Built a Java application service for internal tools.", paragraph.getText());
            assertEquals("Georgia", paragraph.getRuns().get(0).getFontFamily());
            assertTrue(paragraph.getRuns().get(0).isBold());
            assertEquals("Arial", paragraph.getRuns().get(1).getFontFamily());
            assertTrue(paragraph.getRuns().get(1).isItalic());
            assertEquals("Courier New", paragraph.getRuns().get(2).getFontFamily());
        }
    }

    @Test
    void duplicateTargetParagraphIsRejectedInsteadOfEditingTheWrongCopy() throws Exception {
        byte[] masterBytes;
        try (XWPFDocument master = new XWPFDocument(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            master.createParagraph().createRun().setText("Java developer");
            master.createParagraph().createRun().setText("Java developer");
            master.write(output); masterBytes = output.toByteArray();
        }
        assertThrows(org.springframework.web.server.ResponseStatusException.class, () ->
            new TailoredResumeController().editMasterTemplate(masterBytes,
                List.of(new TailoredResumeController.TemplateEdit("Java developer", "Java engineer"))));
    }
}
