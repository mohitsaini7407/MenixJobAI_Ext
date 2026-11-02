package com.menix.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import java.util.Map;
import org.junit.jupiter.api.Test;

class AnalysisScoringTest {
    @Test
    void renormalizesWeightsWhenComponentsAreNull() {
        assertEquals(69, AnalysisScoring.total(Map.of("skills", 80, "keywords", 50)));
    }

    @Test
    void returnsNullWhenEveryComponentIsUnavailable() {
        assertNull(AnalysisScoring.total(Map.of()));
    }
}
