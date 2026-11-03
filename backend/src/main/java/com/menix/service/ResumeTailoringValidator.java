package com.menix.service;

import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Conservative checks around AI-proposed resume edits. This never mutates the master resume. */
public final class ResumeTailoringValidator {
    private static final Pattern NUMBER = Pattern.compile("(?<![\\p{L}\\p{N}])\\d+(?:[.,]\\d+)?(?![\\p{L}\\p{N}])");
    private static final Pattern SPECIFIC_TERM = Pattern.compile("\\b[A-Z][A-Za-z0-9+#.]*\\b");
    private static final Set<String> SAFE_SENTENCE_STARTS = Set.of("The", "A", "An", "Built", "Create", "Created", "Develop", "Developed", "Design", "Designed", "Implement", "Implemented", "Work", "Worked", "Collaborate", "Collaborated", "Deliver", "Delivered", "Improve", "Improved", "Support", "Supported", "Use", "Used", "Lead", "Led", "Manage", "Managed", "Responsible", "Experience", "Summary", "Skills", "Project", "Projects", "Professional", "Experienced", "Skilled", "Proven", "Strong", "Efficient", "Software", "Developer", "Engineer", "Technical", "Relevant", "Additional", "My", "Our", "We", "I", "As", "With", "For", "In", "To");

    private ResumeTailoringValidator() {}

    public static Validation validate(String masterResume, String workingResume, String jobDescription,
                                      String before, String after, List<String> evidence) {
        return validate(masterResume, workingResume, jobDescription, before, after, evidence, List.of());
    }

    public static Validation validate(String masterResume, String workingResume, String jobDescription,
                                      String before, String after, List<String> evidence, List<String> confirmedFacts) {
        if (masterResume == null || masterResume.isBlank()) return new Validation(false, "Master Resume evidence is unavailable.");
        String evidenceSource = masterResume + "\n" + String.join("\n", confirmedFacts == null ? List.of() : confirmedFacts);
        if (before == null || before.isBlank() || !containsNormalized(workingResume, before)) {
            return new Validation(false, "The source text was not found in the working resume.");
        }
        if (after == null || after.isBlank()) return new Validation(false, "The proposed replacement is empty.");
        if (evidence == null || evidence.isEmpty() || evidence.stream().anyMatch(item -> !containsNormalized(evidenceSource, item))) {
            return new Validation(false, "No exact supporting excerpt was found in the Master Resume or user-confirmed facts.");
        }
        Matcher originalNumbers = NUMBER.matcher(before);
        while (originalNumbers.find()) if (!containsNormalized(after, originalNumbers.group())) {
            return new Validation(false, "The proposed edit removes a source number, date, or metric.");
        }
        Matcher originalTerms = SPECIFIC_TERM.matcher(before);
        while (originalTerms.find()) {
            String term = originalTerms.group();
            if (SAFE_SENTENCE_STARTS.contains(term)) continue;
            if (!containsNormalized(after, term)) {
                return new Validation(false, "The proposed edit removes a named technology, project, organization, or other source fact.");
            }
        }
        Matcher numbers = NUMBER.matcher(after);
        while (numbers.find()) if (!containsNormalized(evidenceSource, numbers.group())) {
            return new Validation(false, "The proposed edit adds a number or metric absent from the Master Resume and user-confirmed facts.");
        }
        Matcher terms = SPECIFIC_TERM.matcher(after);
        while (terms.find()) {
            String term = terms.group();
            if (SAFE_SENTENCE_STARTS.contains(term)) continue;
            if (!containsNormalized(evidenceSource, term)) {
                return new Validation(false, "The proposed edit adds a named skill or claim without Master Resume or user-confirmed evidence.");
            }
        }
        return new Validation(true, "Verified against quoted Master Resume evidence.");
    }

    private static boolean containsNormalized(String source, String fragment) {
        if (source == null || fragment == null || fragment.isBlank()) return false;
        return source.toLowerCase(Locale.ROOT).replaceAll("\\s+", " ")
            .contains(fragment.toLowerCase(Locale.ROOT).replaceAll("\\s+", " ").trim());
    }

    public record Validation(boolean valid, String reason) {}
}
