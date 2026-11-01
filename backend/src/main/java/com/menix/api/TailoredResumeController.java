package com.menix.api;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.poi.xwpf.usermodel.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.client.RestClient;
import org.springframework.web.server.ResponseStatusException;

import java.io.ByteArrayOutputStream;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.*;

@RestController
@RequestMapping("/api/ai")
public class TailoredResumeController {
    @Value("${menix.gemini.api-key:}") private String apiKey;
    @Value("${menix.gemini.model:gemini-2.5-flash}") private String model;
    private final ObjectMapper mapper = new ObjectMapper();

    public record TailoredDocxRequest(String resumeText, String jobDescription, String fullName) {}

    @PostMapping(value = "/tailor-docx", produces = "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
    public ResponseEntity<byte[]> tailorDocx(@RequestBody TailoredDocxRequest request) {
        if (apiKey == null || apiKey.isBlank()) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "Gemini API key is not configured. Set GEMINI_API_KEY on the backend.");
        }
        if (request.resumeText() == null || request.resumeText().isBlank() || request.jobDescription() == null || request.jobDescription().isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Master resume text and job description are required.");
        }
        try {
            String prompt = "You are an accurate ATS resume editor. Rewrite and organize ONLY facts supported by the master resume. Never invent skills, tools, employers, dates, education, metrics, certifications, responsibilities or achievements. Do not claim a missing job requirement as a skill. Preserve factual meaning. Tailor emphasis and ordering to the job description. Return ONLY valid JSON in this exact structure: {\"name\":\"candidate name\",\"headline\":\"truthful headline\",\"summary\":\"truthful professional summary\",\"sections\":[{\"heading\":\"Skills\",\"items\":[\"...\"]},{\"heading\":\"Experience\",\"items\":[\"...\"]},{\"heading\":\"Projects\",\"items\":[\"...\"]},{\"heading\":\"Education\",\"items\":[\"...\"]}]} Omit empty sections. Do not add unsupported content. Master resume:\n" + request.resumeText() + "\nTARGET JOB DESCRIPTION:\n" + request.jobDescription();
            String url = "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + apiKey;
            Map<String, Object> body = Map.of(
                "contents", List.of(Map.of("parts", List.of(Map.of("text", prompt)))),
                "generationConfig", Map.of("responseMimeType", "application/json", "temperature", 0.2)
            );
            Map response = RestClient.create().post().uri(url).contentType(MediaType.APPLICATION_JSON).body(body).retrieve().body(Map.class);
            String generated = extractText(response);
            JsonNode root = mapper.readTree(stripFences(generated));
            byte[] docx = buildDocx(root, request.fullName());
            String date = LocalDate.now(ZoneId.of("Asia/Kolkata")).toString();
            String filename = "MohitSaini_" + date + ".docx";
            return ResponseEntity.ok()
                .contentType(MediaType.parseMediaType("application/vnd.openxmlformats-officedocument.wordprocessingml.document"))
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"" + filename + "\"")
                .body(docx);
        } catch (ResponseStatusException ex) {
            throw ex;
        } catch (Exception ex) {
            throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, "Could not generate the tailored DOCX: " + ex.getMessage());
        }
    }

    private String extractText(Map response) {
        if (response == null) throw new IllegalStateException("Gemini returned an empty response.");
        List candidates = (List) response.get("candidates");
        if (candidates == null || candidates.isEmpty()) throw new IllegalStateException("Gemini returned no candidate content.");
        Map candidate = (Map) candidates.get(0);
        Map content = (Map) candidate.get("content");
        List parts = content == null ? null : (List) content.get("parts");
        if (parts == null || parts.isEmpty()) throw new IllegalStateException("Gemini response did not contain text.");
        return String.valueOf(((Map) parts.get(0)).get("text"));
    }

    private String stripFences(String text) {
        String value = text == null ? "" : text.trim();
        if (value.startsWith("```") ) {
            value = value.replaceFirst("^```(?:json)?\\s*", "").replaceFirst("\\s*```$", "");
        }
        return value;
    }

    private byte[] buildDocx(JsonNode root, String fallbackName) throws Exception {
        try (XWPFDocument document = new XWPFDocument(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            String name = root.path("name").asText(fallbackName == null || fallbackName.isBlank() ? "Mohit Saini" : fallbackName);
            XWPFParagraph title = document.createParagraph(); title.setAlignment(ParagraphAlignment.CENTER);
            XWPFRun nameRun = title.createRun(); nameRun.setText(name); nameRun.setBold(true); nameRun.setFontSize(20); nameRun.setFontFamily("Aptos");
            String headline = root.path("headline").asText("");
            if (!headline.isBlank()) { XWPFParagraph p = document.createParagraph(); p.setAlignment(ParagraphAlignment.CENTER); XWPFRun r=p.createRun(); r.setText(headline); r.setFontSize(10); r.setColor("475569"); }
            String summary = root.path("summary").asText("");
            if (!summary.isBlank()) addSection(document, "PROFESSIONAL SUMMARY", List.of(summary));
            JsonNode sections = root.path("sections");
            if (sections.isArray()) {
                for (JsonNode section : sections) {
                    String heading = section.path("heading").asText("").trim();
                    List<String> items = new ArrayList<>();
                    JsonNode values = section.path("items");
                    if (values.isArray()) for (JsonNode item : values) if (!item.asText().isBlank()) items.add(item.asText());
                    if (!heading.isBlank() && !items.isEmpty()) addSection(document, heading.toUpperCase(Locale.ROOT), items);
                }
            }
            document.write(out); return out.toByteArray();
        }
    }

    private void addSection(XWPFDocument document, String heading, List<String> items) {
        XWPFParagraph h = document.createParagraph(); h.setSpacingBefore(180); h.setSpacingAfter(60);
        XWPFRun hr = h.createRun(); hr.setText(heading); hr.setBold(true); hr.setFontSize(11); hr.setColor("1D4ED8"); hr.setFontFamily("Aptos");
        for (String item : items) {
            XWPFParagraph p = document.createParagraph(); p.setSpacingAfter(45);
            XWPFRun r = p.createRun(); r.setText(item); r.setFontSize(10); r.setFontFamily("Aptos");
        }
    }
}
