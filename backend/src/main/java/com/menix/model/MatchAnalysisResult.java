package com.menix.model;

import java.util.List;
import java.util.Map;

public record MatchAnalysisResult(
    int totalScore,
    Map<String, Integer> componentScores,
    String calculationFormula,
    RoleFamily.Fit familyFit,
    RoleFamily jobFamily,
    RoleFamily resumeFamily,
    String verdict,
    List<String> verdictReasons,
    List<RequirementItem> requirements,
    List<String> matchedSkills,
    List<String> missingSkills,
    List<String> unrequestedResumeSkills,
    List<String> redFlags
) {
    public MatchAnalysisResult {
        componentScores = componentScores == null ? Map.of() : Map.copyOf(componentScores);
        verdictReasons = verdictReasons == null ? List.of() : List.copyOf(verdictReasons);
        requirements = requirements == null ? List.of() : List.copyOf(requirements);
        matchedSkills = matchedSkills == null ? List.of() : List.copyOf(matchedSkills);
        missingSkills = missingSkills == null ? List.of() : List.copyOf(missingSkills);
        unrequestedResumeSkills = unrequestedResumeSkills == null ? List.of() : List.copyOf(unrequestedResumeSkills);
        redFlags = redFlags == null ? List.of() : List.copyOf(redFlags);
    }

    public record RequirementItem(
        String id,
        String text,
        String kind,
        String status,
        String evidence,
        String confidence
    ) {}
}
