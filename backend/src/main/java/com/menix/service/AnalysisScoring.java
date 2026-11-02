package com.menix.service;

import java.util.LinkedHashMap;
import java.util.Map;

public final class AnalysisScoring {
    private static final Map<String, Double> WEIGHTS = Map.of(
        "skills", 0.45,
        "keywords", 0.25,
        "experience", 0.20,
        "education", 0.10
    );

    private AnalysisScoring() {}

    public static Integer total(Map<String, ?> scores) {
        double weighted = 0;
        double availableWeight = 0;
        for (var entry : WEIGHTS.entrySet()) {
            Object value = scores.get(entry.getKey());
            if (!(value instanceof Number number)) continue;
            double score = Math.max(0, Math.min(100, number.doubleValue()));
            weighted += score * entry.getValue();
            availableWeight += entry.getValue();
        }
        return availableWeight == 0 ? null : (int) Math.round(weighted / availableWeight);
    }

    public static String level(Integer score) {
        if (score == null) return "Not scored";
        if (score >= 80) return "Strong Match";
        if (score >= 65) return "Good Match";
        if (score >= 40) return "Partial Match";
        return "Low Match";
    }

    public static Map<String, Integer> normalizeScores(Map<String, ?> source) {
        Map<String, Integer> normalized = new LinkedHashMap<>();
        for (String component : WEIGHTS.keySet()) {
            Object value = source.get(component);
            if (value instanceof Number number) {
                normalized.put(component, Math.max(0, Math.min(100, number.intValue())));
            } else {
                normalized.put(component, null);
            }
        }
        return normalized;
    }
}
