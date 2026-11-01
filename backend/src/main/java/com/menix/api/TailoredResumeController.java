package com.menix.api;

import org.apache.poi.xwpf.usermodel.*;
import org.openxmlformats.schemas.wordprocessingml.x2006.main.*;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

import java.io.ByteArrayOutputStream;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.*;

@RestController
@RequestMapping("/api/ai")
public class TailoredResumeController {
    private static final String DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    public record TailoredDocxRequest(String resumeText, String jobDescription, String fullName) {}
    private record ResumeLine(String text, boolean entry) {}
    private record ResumeSection(String heading, List<ResumeLine> lines) {}
    private record ResumeData(String name, String contact, List<ResumeSection> sections) {}

    @PostMapping(value = "/tailor-docx", produces = DOCX_TYPE)
    public ResponseEntity<byte[]> tailorDocx(@RequestBody TailoredDocxRequest request) {
        if (request == null || request.resumeText() == null || request.resumeText().isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Master resume text is required.");
        }
        try {
            ResumeData resume = parseResume(request.resumeText(), request.fullName());
            byte[] docx = buildDocx(resume);
            String date = LocalDate.now(ZoneId.of("Asia/Kolkata")).toString();
            String safeName = resume.name().replaceAll("[^A-Za-z0-9_-]", "");
            if (safeName.isBlank()) safeName = "Candidate";
            String filename = safeName + "_ATS_Resume_" + date + ".docx";
            return ResponseEntity.ok().contentType(MediaType.parseMediaType(DOCX_TYPE))
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"" + filename + "\"").body(docx);
        } catch (ResponseStatusException ex) {
            throw ex;
        } catch (Exception ex) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "Could not format the resume: " + ex.getMessage());
        }
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
                XWPFRun contactRun = contactP.createRun(); contactRun.setText(resume.contact());
                contactRun.setFontFamily("Aptos"); contactRun.setFontSize(8); contactRun.setColor("475569");
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
        p.setBorderBottom(Borders.SINGLE); p.setBorderBottomSize(6); p.setBorderBottomColor("CBD5E1");
        XWPFRun r = p.createRun(); r.setText(heading); r.setBold(true); r.setFontFamily("Aptos");
        r.setFontSize(10); r.setColor("1D4ED8");
    }

    private void addEntryLine(XWPFDocument doc, String text) {
        String[] parts = text.split("\\t+");
        XWPFParagraph p = doc.createParagraph(); p.setSpacingBefore(65); p.setSpacingAfter(25); p.setKeepNext(true);
        XWPFRun main = p.createRun(); main.setText(parts[0].trim()); main.setBold(true);
        main.setFontFamily("Aptos"); main.setFontSize(9); main.setColor("172B4D");
        for (int i = 1; i < parts.length; i++) {
            XWPFRun extra = p.createRun(); extra.setText("  |  " + parts[i].trim());
            extra.setFontFamily("Aptos"); extra.setFontSize(8); extra.setColor("475569");
        }
    }

    private void addSkillLine(XWPFDocument doc, String text) {
        int colon = text.indexOf(':'); XWPFParagraph p = doc.createParagraph(); p.setSpacingAfter(35);
        XWPFRun label = p.createRun(); label.setText(text.substring(0, colon + 1) + " "); label.setBold(true);
        label.setFontFamily("Aptos"); label.setFontSize(8.7); label.setColor("172B4D");
        XWPFRun value = p.createRun(); value.setText(text.substring(colon + 1).trim());
        value.setFontFamily("Aptos"); value.setFontSize(8.7); value.setColor("334155");
    }

    private void addBodyLine(XWPFDocument doc, String text) {
        XWPFParagraph p = doc.createParagraph(); p.setSpacingAfter(45); p.setLineSpacing(1.05);
        XWPFRun r = p.createRun(); r.setText(text); r.setFontFamily("Aptos"); r.setFontSize(9); r.setColor("263445");
    }

    private void addBullet(XWPFDocument doc, String text) {
        XWPFParagraph p = doc.createParagraph(); p.setIndentationLeft(260); p.setFirstLineIndentation(-150);
        p.setSpacingAfter(40); p.setLineSpacing(1.03);
        XWPFRun bullet = p.createRun(); bullet.setText("•  "); bullet.setFontFamily("Aptos"); bullet.setFontSize(9); bullet.setColor("1D4ED8");
        XWPFRun body = p.createRun(); body.setText(text); body.setFontFamily("Aptos"); body.setFontSize(9); body.setColor("263445");
    }

    private boolean looksLikeBullet(String text) {
        return text.startsWith("•") || text.startsWith("·") || text.startsWith("- ") || text.startsWith("– ");
    }

    private String cleanBullet(String text) {
        return text.replaceFirst("^[•·]\\s*", "").replaceFirst("^[-–]\\s*", "").trim();
    }

    private void addPageNumberFooter(XWPFDocument doc) {
        XWPFFooter footer = doc.createFooter(HeaderFooterType.DEFAULT);
        XWPFParagraph p = footer.getParagraphs().get(0); p.setAlignment(ParagraphAlignment.CENTER);
        XWPFRun r = p.createRun(); r.setFontFamily("Aptos"); r.setFontSize(8); r.setColor("64748B"); r.setText("Page ");
        r.getCTR().addNewFldChar().setFldCharType(STFldCharType.BEGIN);
        r = p.createRun(); r.getCTR().addNewInstrText().setStringValue(" PAGE ");
        r = p.createRun(); r.getCTR().addNewFldChar().setFldCharType(STFldCharType.END);
    }
}
