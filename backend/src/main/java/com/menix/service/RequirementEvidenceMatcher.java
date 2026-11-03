package com.menix.service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/** Deterministic validation and scoring for requirements extracted from each job description. */
public final class RequirementEvidenceMatcher {
    private static final Map<String, Double> BASE_WEIGHTS = Map.of(
        "requiredSkills", 35d, "relevantExperience", 25d, "projectsResponsibilities", 15d,
        "preferredSkills", 10d, "keywords", 10d, "educationCertifications", 5d
    );
    private static final Map<String, String> ALIASES = aliases();
    // Naukri job pages often append navigation, legal and company footer text to
    // the visible JD. These terms are not candidate requirements on their own.
    private static final Set<String> PAGE_NOISE = Set.of(
        "about", "careers", "employer", "home", "sitemap", "credits", "help", "center",
        "summons", "notices", "grievances", "report", "issue", "privacy", "policy",
        "terms", "conditions", "fraud", "alert", "trust", "safety", "apply", "get",
        "real", "connect", "time", "app", "ltd", "limited", "copyright", "contact",
        "support", "login", "signup", "subscribe", "download", "share", "follow"
    );

    private RequirementEvidenceMatcher() {}

    public static Result evaluate(List<Map<String, Object>> rawRequirements, String resumeText,
                                  String seniority, boolean resumeAvailable) {
        String resume = normalize(resumeText);
        List<Map<String, Object>> requirements = new ArrayList<>();
        Map<String, Double> earned = new LinkedHashMap<>();
        Map<String, Double> possible = new LinkedHashMap<>();
        Set<String> seenRequirements = new LinkedHashSet<>();
        BASE_WEIGHTS.keySet().forEach(key -> { earned.put(key, 0d); possible.put(key, 0d); });

        List<Map<String, Object>> ordered = new ArrayList<>(rawRequirements == null ? List.of() : rawRequirements);
        ordered.sort(java.util.Comparator.comparingInt(item -> categoryPriority(clean(item.get("category")))));
        for (Map<String, Object> raw : ordered) {
            String name = clean(raw.get("name"));
            if (name.isBlank()) continue;
            if (isPageNoise(name)) continue;
            if (!seenRequirements.add(canonical(name))) continue;
            String category = enumValue(raw.get("category"), Set.of("REQUIRED_SKILL", "PREFERRED_SKILL", "EXPERIENCE",
                "PROJECT_RESPONSIBILITY", "KEYWORD", "EDUCATION_CERTIFICATION", "ELIGIBILITY"), "REQUIRED_SKILL");
            String importance = enumValue(raw.get("importance"), Set.of("MUST_HAVE", "PREFERRED", "OPTIONAL", "RESPONSIBILITY", "EDUCATION", "EXPERIENCE", "CERTIFICATION", "ELIGIBILITY"), "MUST_HAVE");
            String modelClassification = enumValue(raw.get("classification"), Set.of("EXACT_MATCH", "EQUIVALENT_MATCH", "RELATED_EXPERIENCE", "MISSING", "UNKNOWN"), "UNKNOWN");
            String evidence = clean(raw.get("evidence"));
            String evidenceSection = enumValue(raw.get("evidenceSection"), Set.of("SKILLS", "EXPERIENCE", "INTERNSHIP", "PROJECTS", "EDUCATION", "CERTIFICATIONS", "ACHIEVEMENTS", "OTHER", "UNKNOWN"), "UNKNOWN");
            boolean quoteVerified = !evidence.isBlank() && containsPhrase(resume, evidence);

            String classification;
            String verifiedEvidence = "";
            if (!resumeAvailable) classification = "UNKNOWN";
            else if (containsTerm(resume, name)) {
                classification = "EXACT_MATCH";
                verifiedEvidence = bestEvidence(evidence, name, resumeText);
            } else if (equivalentPresent(resume, name)) {
                classification = "EQUIVALENT_MATCH";
                verifiedEvidence = quoteVerified ? evidence : findAliasEvidence(name, resumeText);
            } else if (category.equals("EDUCATION_CERTIFICATION")
                && modelClassification.equals("EQUIVALENT_MATCH") && quoteVerified) {
                classification = "EQUIVALENT_MATCH";
                verifiedEvidence = evidence;
            } else if (modelClassification.equals("RELATED_EXPERIENCE") && quoteVerified) {
                classification = "RELATED_EXPERIENCE";
                verifiedEvidence = evidence;
            } else if (quoteVerified && (modelClassification.equals("EXACT_MATCH") || modelClassification.equals("EQUIVALENT_MATCH"))) {
                // A cited resume passage is real, but does not prove the named requirement; retain it as transferable evidence.
                classification = "RELATED_EXPERIENCE";
                verifiedEvidence = evidence;
            } else if (modelClassification.equals("UNKNOWN")) {
                classification = "UNKNOWN";
            } else {
                classification = "MISSING";
            }

            String scoreCategory = scoringCategory(category);
            double importanceWeight = importanceWeight(importance);
            double credit = switch (classification) {
                case "EXACT_MATCH" -> 1d;
                case "EQUIVALENT_MATCH" -> 0.9d;
                case "RELATED_EXPERIENCE" -> 0.5d;
                case "MISSING" -> 0d;
                default -> -1d;
            };
            if (credit >= 0 && !scoreCategory.isBlank()) {
                possible.compute(scoreCategory, (key, value) -> value + importanceWeight);
                earned.compute(scoreCategory, (key, value) -> value + importanceWeight * credit);
            }

            Map<String, Object> item = new LinkedHashMap<>();
            item.put("name", name);
            item.put("category", category);
            item.put("importance", importance);
            item.put("classification", classification);
            item.put("evidence", verifiedEvidence);
            item.put("evidenceSection", verifiedEvidence.isBlank() ? "UNKNOWN" : (evidenceSection.equals("UNKNOWN") ? inferSection(resumeText, verifiedEvidence) : evidenceSection));
            item.put("confidence", verifiedEvidence.isBlank() ? "low" : clean(raw.getOrDefault("confidence", "medium")));
            item.put("explanation", clean(raw.get("explanation")));
            requirements.add(item);
        }

        Map<String, Integer> breakdown = new LinkedHashMap<>();
        possible.forEach((category, denominator) -> breakdown.put(category,
            denominator == 0 ? null : (int) Math.round(100 * earned.get(category) / denominator)));
        Map<String, Double> weights = adjustedWeights(seniority);
        double weighted = 0, available = 0;
        for (String key : BASE_WEIGHTS.keySet()) {
            Integer value = breakdown.get(key);
            if (value == null) continue;
            weighted += value * weights.get(key);
            available += weights.get(key);
        }
        Integer total = available == 0 ? null : (int) Math.round(weighted / available);
        return new Result(requirements, breakdown, total, weights);
    }

    public record Result(List<Map<String, Object>> requirements, Map<String, Integer> breakdown,
                         Integer matchScore, Map<String, Double> weights) {}

    private static String scoringCategory(String category) {
        return switch (category) {
            case "EXPERIENCE" -> "relevantExperience";
            case "PROJECT_RESPONSIBILITY" -> "projectsResponsibilities";
            case "PREFERRED_SKILL" -> "preferredSkills";
            case "KEYWORD" -> "keywords";
            case "EDUCATION_CERTIFICATION" -> "educationCertifications";
            case "ELIGIBILITY" -> "";
            default -> "requiredSkills";
        };
    }

    private static int categoryPriority(String category) {
        return switch (category.toUpperCase(Locale.ROOT)) {
            case "REQUIRED_SKILL" -> 0; case "EXPERIENCE" -> 1; case "PROJECT_RESPONSIBILITY" -> 2;
            case "PREFERRED_SKILL" -> 3; case "KEYWORD" -> 4; case "EDUCATION_CERTIFICATION" -> 5; default -> 6;
        };
    }

    private static Map<String, Double> adjustedWeights(String seniority) {
        Map<String, Double> weights = new LinkedHashMap<>(BASE_WEIGHTS);
        String level = seniority == null ? "" : seniority.toLowerCase(Locale.ROOT);
        if (level.matches(".*\\b(senior|lead|staff|principal|manager|director|head)\\b.*")) {
            weights.put("requiredSkills", 30d); weights.put("relevantExperience", 35d);
            weights.put("projectsResponsibilities", 15d); weights.put("preferredSkills", 5d);
            weights.put("keywords", 10d); weights.put("educationCertifications", 5d);
        } else if (level.matches(".*\\b(entry|junior|fresher|graduate|intern)\\b.*")) {
            weights.put("requiredSkills", 40d); weights.put("relevantExperience", 15d);
            weights.put("projectsResponsibilities", 20d); weights.put("preferredSkills", 10d);
            weights.put("keywords", 10d); weights.put("educationCertifications", 5d);
        }
        return weights;
    }

    private static double importanceWeight(String importance) {
        return switch (importance) { case "MUST_HAVE" -> 2d; case "PREFERRED" -> 1d; case "OPTIONAL" -> 0.5d; default -> 1.25d; };
    }

    private static boolean equivalentPresent(String resume, String requirement) {
        String canonical = canonical(requirement);
        for (Map.Entry<String, String> alias : ALIASES.entrySet()) {
            if (alias.getValue().equals(canonical) && !alias.getKey().equals(normalize(requirement)) && containsTerm(resume, alias.getKey())) return true;
        }
        return false;
    }

    private static String inferSection(String resume, String evidence) {
        if (resume == null || evidence == null) return "UNKNOWN";
        int at = resume.toLowerCase(Locale.ROOT).indexOf(evidence.toLowerCase(Locale.ROOT));
        if (at < 0) return "UNKNOWN";
        String before = resume.substring(0, at).toLowerCase(Locale.ROOT);
        String heading = before.replaceAll("(?s).*\\b(education|skills|experience|internship|projects|certifications|achievements)\\b.*", "$1");
        return switch (heading) {
            case "education" -> "EDUCATION"; case "skills" -> "SKILLS"; case "experience" -> "EXPERIENCE";
            case "internship" -> "INTERNSHIP"; case "projects" -> "PROJECTS"; case "certifications" -> "CERTIFICATIONS";
            case "achievements" -> "ACHIEVEMENTS"; default -> "OTHER";
        };
    }

    private static String findAliasEvidence(String requirement, String resumeText) {
        String canonical = canonical(requirement);
        return ALIASES.entrySet().stream().filter(entry -> entry.getValue().equals(canonical))
            .map(Map.Entry::getKey).filter(alias -> containsTerm(normalize(resumeText), alias))
            .findFirst().orElse("");
    }

    private static String bestEvidence(String quoted, String name, String resumeText) {
        if (!quoted.isBlank() && containsPhrase(normalize(resumeText), quoted)) return quoted;
        return findLiteralCaseInsensitive(resumeText, name);
    }

    private static String findLiteralCaseInsensitive(String source, String term) {
        if (source == null || term == null) return "";
        int at = source.toLowerCase(Locale.ROOT).indexOf(term.toLowerCase(Locale.ROOT));
        return at < 0 ? term : source.substring(at, Math.min(source.length(), at + term.length()));
    }

    private static boolean containsTerm(String normalizedSource, String term) {
        String normalizedTerm = normalize(term);
        if (normalizedTerm.isBlank()) return false;
        String haystack = " " + normalizedSource + " ";
        return haystack.contains(" " + normalizedTerm + " ");
    }

    private static boolean containsPhrase(String normalizedSource, String phrase) {
        String normalized = normalize(phrase);
        return !normalized.isBlank() && normalizedSource.contains(normalized);
    }

    private static String canonical(String value) {
        String normalized = normalize(value);
        return ALIASES.getOrDefault(normalized, normalized);
    }

    private static boolean isPageNoise(String value) {
        String normalized = normalize(value);
        if (normalized.isBlank()) return true;
        String[] words = normalized.split(" ");
        // Reject a generic footer/navigation label even if the model wraps it
        // in a longer phrase such as "connect with us" or "privacy policy".
        if (words.length <= 3 && java.util.Arrays.stream(words).allMatch(PAGE_NOISE::contains)) return true;
        return words.length == 1 && PAGE_NOISE.contains(normalized);
    }

    private static String normalize(String value) {
        return value == null ? "" : value.toLowerCase(Locale.ROOT).replaceAll("[^\\p{L}\\p{N}+#.]+", " ").replaceAll("\\s+", " ").trim();
    }

    private static String clean(Object value) { return value == null ? "" : value.toString().replaceAll("\\s+", " ").trim(); }

    private static String enumValue(Object value, Set<String> allowed, String fallback) {
        String normalized = clean(value).toUpperCase(Locale.ROOT).replace(' ', '_');
        return allowed.contains(normalized) ? normalized : fallback;
    }

    private static Map<String, String> aliases() {
        Map<String, String> map = new LinkedHashMap<>();
        addAliases(map, "javascript", "javascript", "js", "ecmascript");
        addAliases(map, "typescript", "typescript", "ts");
        addAliases(map, "react", "react", "reactjs", "react.js");
        addAliases(map, "html5", "html", "html5");
        addAliases(map, "css3", "css", "css3");
        addAliases(map, "rest api", "rest", "rest api", "restful api", "restful apis");
        addAliases(map, "node.js", "node", "nodejs", "node.js");
        addAliases(map, "postgresql", "postgres", "postgresql");
        addAliases(map, "c sharp", "c#", "c sharp");
        addAliases(map, "dotnet", ".net", "dotnet");
        addAliases(map, "amazon web services", "aws", "amazon web services");
        addAliases(map, "google cloud platform", "gcp", "google cloud platform");
        addAliases(map, "microsoft azure", "azure", "microsoft azure");
        addAliases(map, "continuous integration", "ci", "continuous integration");
        addAliases(map, "continuous delivery", "cd", "continuous delivery", "continuous deployment");
        return Map.copyOf(map);
    }

    private static void addAliases(Map<String, String> map, String canonical, String... names) {
        String normalizedCanonical = normalize(canonical);
        for (String name : names) map.put(normalize(name), normalizedCanonical);
    }
}
