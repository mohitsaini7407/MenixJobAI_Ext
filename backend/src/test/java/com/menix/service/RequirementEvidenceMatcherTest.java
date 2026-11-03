package com.menix.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class RequirementEvidenceMatcherTest {
    @Test
    void validatesExactEquivalentRelatedAndMissingEvidence() {
        String resume = "SKILLS\nJavaScript, React, Node\nPROJECTS\nBuilt component-based frontend applications for a student portal.";
        var result = RequirementEvidenceMatcher.evaluate(List.of(
            requirement("React", "REQUIRED_SKILL", "EXACT_MATCH", "React", "SKILLS"),
            requirement("Node.js", "REQUIRED_SKILL", "EQUIVALENT_MATCH", "Node", "SKILLS"),
            requirement("Angular", "REQUIRED_SKILL", "RELATED_EXPERIENCE", "Built component-based frontend applications", "PROJECTS"),
            requirement("Python", "REQUIRED_SKILL", "MISSING", "", "UNKNOWN")
        ), resume, "junior", true);

        Map<String, Map<String, Object>> byName = result.requirements().stream()
            .collect(java.util.stream.Collectors.toMap(item -> item.get("name").toString(), item -> item));
        assertEquals("EXACT_MATCH", byName.get("React").get("classification"));
        assertEquals("EQUIVALENT_MATCH", byName.get("Node.js").get("classification"));
        assertEquals("RELATED_EXPERIENCE", byName.get("Angular").get("classification"));
        assertEquals("MISSING", byName.get("Python").get("classification"));
        assertEquals("", byName.get("Python").get("evidence"));
        assertTrue(result.matchScore() >= 0 && result.matchScore() <= 100);
    }

    @Test
    void unrelatedSkillsCannotImproveScoreAndDuplicatesAreCountedOnce() {
        String resume = "SKILLS\nReact, Kubernetes, AWS";
        var one = RequirementEvidenceMatcher.evaluate(List.of(
            requirement("React", "REQUIRED_SKILL", "EXACT_MATCH", "React", "SKILLS")
        ), resume, "", true);
        var withIrrelevant = RequirementEvidenceMatcher.evaluate(List.of(
            requirement("React", "REQUIRED_SKILL", "EXACT_MATCH", "React", "SKILLS"),
            requirement("Python", "REQUIRED_SKILL", "MISSING", "", "UNKNOWN"),
            requirement("Python", "KEYWORD", "EXACT_MATCH", "Python", "SKILLS")
        ), resume, "", true);

        assertEquals("MISSING", withIrrelevant.requirements().stream().filter(item -> item.get("name").equals("Python"))
            .findFirst().orElseThrow().get("classification"));
        assertEquals(2, withIrrelevant.requirements().size());
        assertTrue(withIrrelevant.matchScore() < one.matchScore());
    }

    @Test
    void seniorJobsIncreaseExperienceWeightAndUnknownRequirementsDoNotBecomeMatches() {
        var result = RequirementEvidenceMatcher.evaluate(List.of(
            requirement("Work authorization", "ELIGIBILITY", "UNKNOWN", "", "UNKNOWN"),
            requirement("5 years of experience", "EXPERIENCE", "UNKNOWN", "", "UNKNOWN")
        ), "Resume with no dates", "Senior Engineer", true);

        assertEquals(35d, result.weights().get("relevantExperience"));
        assertEquals(null, result.matchScore());
        assertFalse(result.requirements().isEmpty());
        assertEquals("UNKNOWN", result.requirements().get(0).get("classification"));
    }

    @Test
    void dropsNaukriFooterAndNavigationWordsBeforeScoring() {
        var result = RequirementEvidenceMatcher.evaluate(List.of(
            requirement("Java", "REQUIRED_SKILL", "MISSING", "", "UNKNOWN"),
            requirement("connect", "REQUIRED_SKILL", "MISSING", "", "UNKNOWN"),
            requirement("Privacy Policy", "REQUIRED_SKILL", "MISSING", "", "UNKNOWN"),
            requirement("Ltd", "REQUIRED_SKILL", "MISSING", "", "UNKNOWN")
        ), "Computer science student; coursework in Java", "entry level", true);

        assertEquals(1, result.requirements().size());
        assertEquals("Java", result.requirements().get(0).get("name"));
        assertEquals("EXACT_MATCH", result.requirements().get(0).get("classification"));
    }

    private Map<String, Object> requirement(String name, String category, String classification, String evidence, String section) {
        return Map.of("name", name, "category", category, "importance", "MUST_HAVE",
            "classification", classification, "evidence", evidence, "evidenceSection", section,
            "confidence", "high", "explanation", "test");
    }
}
