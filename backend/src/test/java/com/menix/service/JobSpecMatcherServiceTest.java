package com.menix.service;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.menix.model.JobSpec;
import com.menix.model.MatchAnalysisResult;
import com.menix.model.RoleFamily;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class JobSpecMatcherServiceTest {

    private ObjectMapper objectMapper;
    private String masterResumeText;

    @BeforeEach
    void setUp() throws IOException {
        objectMapper = new ObjectMapper();
        objectMapper.configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false);

        Path resumePath = Path.of("../tests/fixtures/resume_master.txt");
        if (!Files.exists(resumePath)) {
            resumePath = Path.of("tests/fixtures/resume_master.txt");
        }
        masterResumeText = Files.readString(resumePath);
    }

    private JobSpec loadFixture(String fixtureName) throws IOException {
        Path fixturePath = Path.of("../tests/fixtures/" + fixtureName);
        if (!Files.exists(fixturePath)) {
            fixturePath = Path.of("tests/fixtures/" + fixtureName);
        }
        return objectMapper.readValue(fixturePath.toFile(), JobSpec.class);
    }

    @Test
    @DisplayName("Fixture 1: Non-IT Recruiter must score <= 15, Skip verdict, DIFFERENT family, Night shift flag")
    void testFixture1NonItRecruiter() throws IOException {
        JobSpec spec = loadFixture("fixture_1_non_it_recruiter.json");
        MatchAnalysisResult result = JobSpecMatcherService.evaluate(spec, masterResumeText);

        assertTrue(result.totalScore() <= 15, "Non-IT recruiter score must be <= 15, got: " + result.totalScore());
        assertEquals("Skip", result.verdict());
        assertEquals(RoleFamily.Fit.DIFFERENT, result.familyFit());
        assertEquals(RoleFamily.NON_IT, result.jobFamily());
        assertTrue(result.verdictReasons().stream().anyMatch(r -> r.toLowerCase().contains("different career track")),
                "Reasons must mention different career track: " + result.verdictReasons());
        assertTrue(result.redFlags().stream().anyMatch(rf -> rf.toLowerCase().contains("night shift")),
                "Red flags must include Night shift: " + result.redFlags());
    }

    @Test
    @DisplayName("Fixture 2: Laravel PHP Developer must be DIFFERENT family, score <= 25, verdict Skip, missing PHP & Laravel")
    void testFixture2LaravelPhp() throws IOException {
        JobSpec spec = loadFixture("fixture_2_laravel_php.json");
        MatchAnalysisResult result = JobSpecMatcherService.evaluate(spec, masterResumeText);

        assertTrue(result.totalScore() <= 25,
                "Laravel PHP score must be capped at <= 25 for different track, got: " + result.totalScore());
        assertEquals(RoleFamily.Fit.DIFFERENT, result.familyFit());
        assertEquals(RoleFamily.PHP_LAMP, result.jobFamily());
        assertEquals("Skip", result.verdict());
        assertTrue(result.verdictReasons().stream().anyMatch(r -> r.toLowerCase().contains("different career track")),
                "Reasons must clearly indicate different career track: " + result.verdictReasons());
        assertTrue(result.missingSkills().stream().anyMatch(s -> s.equalsIgnoreCase("php")),
                "Must list PHP as missing: " + result.missingSkills());
        assertTrue(result.missingSkills().stream().anyMatch(s -> s.equalsIgnoreCase("laravel")),
                "Must list Laravel as missing: " + result.missingSkills());
    }

    @Test
    @DisplayName("Fixture 3: SWE Trainee 2026 must score 85-98, match Full Stack, red-flag bond")
    void testFixture3SweTrainee2026() throws IOException {
        JobSpec spec = loadFixture("fixture_3_swe_trainee_2026.json");
        MatchAnalysisResult result = JobSpecMatcherService.evaluate(spec, masterResumeText);

        assertTrue(result.totalScore() >= 85 && result.totalScore() <= 98,
                "SWE Trainee 2026 score must be 85-98, got: " + result.totalScore());
        assertEquals("Strong", result.verdict());
        assertEquals(RoleFamily.Fit.SAME, result.familyFit());
        assertTrue(result.redFlags().stream().anyMatch(rf -> rf.toLowerCase().contains("bond") || rf.toLowerCase().contains("service agreement")),
                "Red flags must include bond / service agreement: " + result.redFlags());
    }

    @Test
    @DisplayName("Fixture 4: Shopify Developer must score 55-75, missing Shopify Liquid / Custom Apps")
    void testFixture4ShopifyDeveloper() throws IOException {
        JobSpec spec = loadFixture("fixture_4_shopify_developer.json");
        MatchAnalysisResult result = JobSpecMatcherService.evaluate(spec, masterResumeText);

        assertTrue(result.totalScore() >= 55 && result.totalScore() <= 75,
                "Shopify Developer score must be 55-75, got: " + result.totalScore());
        assertEquals(RoleFamily.ECOMMERCE_PLATFORM, result.jobFamily());
        assertTrue(result.missingSkills().stream().anyMatch(s -> s.toLowerCase().contains("liquid") || s.toLowerCase().contains("shopify")),
                "Must list Shopify / Liquid as missing: " + result.missingSkills());
    }

    @Test
    @DisplayName("Formula reconciliation: 0.45*skills + 0.25*keywords + 0.20*experience + 0.10*education == totalScore")
    void testFormulaReconciliation() throws IOException {
        JobSpec spec = loadFixture("fixture_3_swe_trainee_2026.json");
        MatchAnalysisResult result = JobSpecMatcherService.evaluate(spec, masterResumeText);

        int skills = result.componentScores().get("skills");
        int keywords = result.componentScores().get("keywords");
        int exp = result.componentScores().get("experience");
        int edu = result.componentScores().get("education");

        int calculated = (int) Math.round(0.45 * skills + 0.25 * keywords + 0.20 * exp + 0.10 * edu);
        assertEquals(calculated, result.totalScore(), "Total score must strictly reconcile with the 4 components");
    }

    @Test
    @DisplayName("Alias consolidation: TDD and Test-Driven Development counted once")
    void testAliasConsolidation() {
        JobSpec spec = new JobSpec(
                "job-tdd-1", "Full Stack Developer", "Tech Solutions", "FULL_STACK_WEB",
                List.of("TDD", "Test-Driven Development", "React"),
                List.of(), List.of(), List.of(),
                0, 2, "B.Tech CSE", "Delhi", "Remote", "Day", "Permanent",
                false, "6-8 LPA", List.of(), List.of()
        );

        MatchAnalysisResult result = JobSpecMatcherService.evaluate(spec, masterResumeText);
        long countTdd = result.requirements().stream()
                .filter(r -> r.text().equalsIgnoreCase("TDD") || r.text().equalsIgnoreCase("Test-Driven Development"))
                .count();
        assertEquals(1, countTdd, "TDD and Test-Driven Development must be consolidated into 1 requirement");
    }
}
