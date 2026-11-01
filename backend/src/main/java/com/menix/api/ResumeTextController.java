package com.menix.api;

import org.apache.pdfbox.Loader;
import org.apache.pdfbox.text.PDFTextStripper;
import org.apache.poi.xwpf.usermodel.XWPFDocument;
import org.apache.poi.xwpf.usermodel.XWPFHyperlink;
import org.apache.poi.xwpf.usermodel.XWPFHyperlinkRun;
import org.apache.poi.xwpf.usermodel.XWPFParagraph;
import org.apache.poi.xwpf.usermodel.XWPFRun;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.server.ResponseStatusException;

import java.io.ByteArrayInputStream;
import java.util.LinkedHashMap;
import java.util.Map;

@RestController
@RequestMapping("/api/resumes")
public class ResumeTextController {
    @PostMapping("/extract-text")
    public Map<String, Object> extractText(@RequestParam("file") MultipartFile file) {
        if (file == null || file.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Choose a PDF or DOCX resume.");
        }
        String name = file.getOriginalFilename() == null ? "resume" : file.getOriginalFilename().toLowerCase();
        try {
            String text;
            if (name.endsWith(".pdf")) {
                try (var pdf = Loader.loadPDF(file.getBytes())) {
                    text = new PDFTextStripper().getText(pdf);
                }
            } else if (name.endsWith(".docx")) {
                try (var doc = new XWPFDocument(new ByteArrayInputStream(file.getBytes()))) {
                    StringBuilder out = new StringBuilder();
                    for (XWPFParagraph paragraph : doc.getParagraphs()) {
                        String paragraphText = extractParagraphText(paragraph, doc);
                        if (!paragraphText.isBlank()) out.append(paragraphText).append("\n");
                    }
                    text = out.toString();
                }
            } else {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Only PDF and DOCX files are supported.");
            }
            if (text == null || text.isBlank()) {
                throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY, "No selectable text was found. If this is a scanned PDF, use OCR or paste the resume text manually.");
            }
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("originalName", file.getOriginalFilename());
            result.put("text", text);
            result.put("characters", text.length());
            return result;
        } catch (ResponseStatusException ex) {
            throw ex;
        } catch (Exception ex) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Could not read this resume: " + ex.getMessage());
        }
    }

    private String extractParagraphText(XWPFParagraph paragraph, XWPFDocument document) {
        StringBuilder text = new StringBuilder();
        for (XWPFRun run : paragraph.getRuns()) {
            String runText = run.text();
            if (run instanceof XWPFHyperlinkRun hyperlinkRun) {
                XWPFHyperlink hyperlink = hyperlinkRun.getHyperlink(document);
                if (hyperlink != null && hyperlink.getURL() != null && !runText.isBlank()) {
                    text.append('[').append(runText).append("](").append(hyperlink.getURL()).append(')');
                    continue;
                }
            }
            text.append(runText);
        }
        return text.isEmpty() ? paragraph.getText() : text.toString();
    }
}
