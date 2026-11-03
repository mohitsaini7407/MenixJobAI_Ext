package com.menix.service;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import org.junit.jupiter.api.Test;

class ResumeTailoringValidatorTest {
    private static final String MASTER = "Project: OrgImpact\nBuilt a React dashboard for 3 client teams.";

    @Test
    void acceptsEditWithExactSourceAndEvidence() {
        var result = ResumeTailoringValidator.validate(MASTER, MASTER, "React developer", "Built a React dashboard", 
            "Built a React dashboard for client teams", List.of("Built a React dashboard for 3 client teams."));
        assertTrue(result.valid());
    }

    @Test
    void rejectsUnsupportedMetricAndJobTechnology() {
        var metric = ResumeTailoringValidator.validate(MASTER, MASTER, "React developer", "Built a React dashboard",
            "Built a React dashboard for 10 client teams", List.of("Built a React dashboard for 3 client teams."));
        var technology = ResumeTailoringValidator.validate(MASTER, MASTER, "React and Angular developer", "Built a React dashboard",
            "Built an Angular dashboard for 3 client teams", List.of("Built a React dashboard for 3 client teams."));
        assertFalse(metric.valid());
        assertFalse(technology.valid());
    }

    @Test
    void rejectsEvidenceNotQuotedFromTheMaster() {
        var result = ResumeTailoringValidator.validate(MASTER, MASTER, "React developer", "Built a React dashboard",
            "Built a React dashboard for client teams", List.of("Delivered 99% performance improvement."));
        assertFalse(result.valid());
    }
}
