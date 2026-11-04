package com.menix.service;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.menix.model.AnalysisCache;
import com.menix.model.ResumeProfile;
import com.menix.repo.AnalysisCacheRepository;
import com.menix.repo.ResumeProfileRepository;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.HexFormat;
import java.util.Locale;
import java.util.Objects;
import java.util.concurrent.CompletableFuture;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;
import org.springframework.web.client.RestClientResponseException;
import org.springframework.web.server.ResponseStatusException;

@Service
public class AiAnalysisService {
    private static final Logger log = LoggerFactory.getLogger(AiAnalysisService.class);
    private static final String PROMPT_VERSION = "overview-evidence-v4-noise-filter";
    private static final String SUGGESTION_VERSION = "suggestions-evidence-v3";
    private static final String ANSWER_VERSION = "application-answers-v1";
    private final RestClient restClient;
    private final ObjectMapper mapper;
    private final AnalysisCacheRepository cacheRepository;
    private final ResumeProfileRepository profileRepository;
    private final Set<String> profilesInFlight = ConcurrentHashMap.newKeySet();

    @Value("${menix.gemini.api-key:}") private String apiKey;
    @Value("${menix.gemini.model:gemini-2.5-flash}") private String model = "gemini-2.5-flash";
    @Value("${menix.gemini.diagnostics-token:}") private String diagnosticsToken;

    public AiAnalysisService(RestClient restClient, ObjectMapper mapper,
                             AnalysisCacheRepository cacheRepository,
                             ResumeProfileRepository profileRepository) {
        this.restClient = restClient;
        this.mapper = mapper;
        this.cacheRepository = cacheRepository;
        this.profileRepository = profileRepository;
    }

    public record OverviewRequest(Map<String, Object> resumeProfile, String resumeText,
                                  String jobDescription, Map<String, Object> jobMeta, String resumeHash) {}
    public record SuggestionsRequest(Map<String, Object> resumeProfile, String resumeText,
                                     String jobDescription, Map<String, Object> jobMeta,
                                     String workingResume, String resumeHash, List<String> confirmedFacts, boolean forceRegenerate) {
        public SuggestionsRequest(Map<String, Object> resumeProfile, String resumeText, String jobDescription,
                                  Map<String, Object> jobMeta, String workingResume, String resumeHash) {
            this(resumeProfile, resumeText, jobDescription, jobMeta, workingResume, resumeHash, List.of(), false);
        }
        public SuggestionsRequest(Map<String, Object> resumeProfile, String resumeText, String jobDescription,
                                  Map<String, Object> jobMeta, String workingResume, String resumeHash, boolean forceRegenerate) {
            this(resumeProfile, resumeText, jobDescription, jobMeta, workingResume, resumeHash, List.of(), forceRegenerate);
        }
    }

    public boolean authorizeDiagnostics(String token) {
        if (diagnosticsToken == null || diagnosticsToken.isBlank() || token == null) return false;
        return MessageDigest.isEqual(diagnosticsToken.getBytes(StandardCharsets.UTF_8), token.getBytes(StandardCharsets.UTF_8));
    }

    public Map<String, Object> overview(OverviewRequest request) {
        validate(request == null ? null : request.jobDescription(),
            request == null ? null : request.resumeText(), request == null ? null : request.resumeProfile());
        long started = System.nanoTime();
        String resumeText = clean(request.resumeText());
        String resumeHash = validHash(request.resumeHash()) ? request.resumeHash() : sha256(resumeText.isBlank()
            ? json(request.resumeProfile()) : resumeText);
        String jobDescription = trimJobDescription(request.jobDescription());
        String key = cacheKey(resumeHash, jobDescription, PROMPT_VERSION);
        Map<String, Object> cached = readCache(key, "overview");
        if (cached != null) {
            cached.put("cached", true);
            cached.put("latencyMs", 0);
            return cached;
        }

        Map<String, Object> profile = request.resumeProfile();
        if (profile == null || profile.isEmpty()) {
            ResumeProfile saved = profileRepository.findById(resumeHash).orElse(null);
            if (saved != null) profile = readObject(saved.getProfileJson());
        }
        Map<String, Object> jobMeta = request.jobMeta() == null ? Map.of() : request.jobMeta();
        String candidateEvidence = !resumeText.isBlank()
            ? "MASTER RESUME TEXT (source of truth; cite exact excerpts only):\n" + resumeText
                + (profile == null || profile.isEmpty() ? "" : "\nSTRUCTURED RESUME PROFILE (navigation aid only):\n" + json(profile))
            : "STRUCTURED RESUME PROFILE (source of truth available):\n" + json(profile);
        String prompt = overviewPrompt(candidateEvidence, jobDescription, jobMeta);
        Map<String, Object> raw = callGemini(prompt, overviewSchema(), 1800, true);
        boolean degraded = Boolean.TRUE.equals(raw.remove("_menixDegraded"));
        String evidenceText = !resumeText.isBlank() ? resumeText : json(profile);
        Map<String, Object> result = normalizeOverview(raw, evidenceText, !evidenceText.isBlank());
        Integer score = (Integer) result.get("matchScore");
        result.put("matchScore", score);
        result.put("matchLevel", AnalysisScoring.level(score));
        result.put("model", model);
        result.put("degraded", degraded);
        result.put("cached", false);
        result.put("latencyMs", (System.nanoTime() - started) / 1_000_000);
        writeCache(key, "overview", result);

        // Profile extraction is done once in the background so it does not delay the first score.
        if ((profile == null || profile.isEmpty()) && !resumeText.isBlank()) {
            CompletableFuture.runAsync(() -> createProfileIfAbsent(resumeHash, resumeText));
        }
        return result;
    }

    public Map<String, Object> queueResumeProfile(String resumeText) {
        if (resumeText == null || resumeText.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Resume text is required.");
        }
        String normalizedResume = clean(resumeText);
        String hash = sha256(normalizedResume);
        ResumeProfile existing = profileRepository.findById(hash).orElse(null);
        if (existing != null) return Map.of("status", "ready", "resumeHash", hash, "profile", readObject(existing.getProfileJson()));
        CompletableFuture.runAsync(() -> createProfileIfAbsent(hash, normalizedResume));
        return Map.of("status", "processing", "resumeHash", hash);
    }

    public Map<String, Object> suggestions(SuggestionsRequest request) {
        validate(request == null ? null : request.jobDescription(),
            request == null ? null : request.resumeText(), request == null ? null : request.resumeProfile());
        String resumeText = clean(request.resumeText());
        String resumeHash = validHash(request.resumeHash()) ? request.resumeHash() : sha256(resumeText.isBlank() ? json(request.resumeProfile()) : resumeText);
        String jobDescription = trimJobDescription(request.jobDescription());
        String candidate = request.workingResume() != null && !request.workingResume().isBlank()
            ? request.workingResume() : resumeText;
        List<String> confirmedFacts = request.confirmedFacts() == null ? List.of() : request.confirmedFacts().stream()
            .filter(Objects::nonNull).map(this::clean).filter(value -> !value.isBlank()).limit(30).toList();
        String key = cacheKey(resumeHash, jobDescription + "\n" + json(confirmedFacts), SUGGESTION_VERSION + "-" + sha256(candidate));
        Map<String, Object> cached = request.forceRegenerate() ? null : readCache(key, "suggestions");
        if (cached != null) { cached.put("cached", true); return cached; }
        String prompt = """
            Tailor the working resume for this specific job using only facts supported by the permanent Master Resume
            or explicitly confirmed by the candidate in the separate user-confirmed facts list.
            Make selective in-place wording improvements only: do not reorder sections, projects or bullets, and do not add
            a technology, employer, date, duration, achievement, metric, credential, responsibility or experience
            that is not explicitly supported by one of those two sources.
            Do not insert job-description terms into the resume unless they are supported by an exact evidence excerpt.
            Return JSON with suggestions (array of {id,section,before,after,reason,relatedRequirement,evidence,confidence}) and cautions.
            Sections may be summary, bullet, skills, project, experience, or achievement. Return at most 8 concise edits. Each `before` must be an exact
            excerpt from one paragraph in the WORKING RESUME; do not combine paragraphs. Keep `after` concise and close
            to the original length so the original page layout is not disrupted. Each evidence item must be an exact, short excerpt from MASTER RESUME
            that directly supports the replacement. Confidence is a number from 0 to 1. Preserve each sentence's
            meaning, names, dates and factual details. If no truthful edit is useful, return an empty suggestions array.
            MASTER RESUME (permanent source of truth):\n%s\nUSER-CONFIRMED CANDIDATE FACTS (usable only as explicitly confirmed):\n%s\nWORKING RESUME:\n%s\nJOB DESCRIPTION:\n%s
            """.formatted(resumeText, json(confirmedFacts), candidate, jobDescription);
        Map<String, Object> raw = callGemini(prompt, suggestionsSchema(), 900, false);
        boolean degraded = Boolean.TRUE.equals(raw.remove("_menixDegraded"));
        List<Map<String, Object>> normalized = new ArrayList<>();
        List<Map<String, Object>> rejected = new ArrayList<>();
        int rejectedCount = 0;
        Object items = raw.get("suggestions");
        if (items instanceof List<?> list) {
            for (Object item : list) {
                if (!(item instanceof Map<?, ?> map)) continue;
                Map<String, Object> suggestion = new LinkedHashMap<>();
                suggestion.put("id", clean(Objects.toString(map.get("id"), "suggestion-" + normalized.size())));
                String section = clean(Objects.toString(map.get("section"), "bullet"));
                suggestion.put("section", List.of("summary", "bullet", "skills", "project", "experience", "achievement").contains(section) ? section : "bullet");
                suggestion.put("before", clean(Objects.toString(map.get("before"), "")));
                suggestion.put("after", clean(Objects.toString(map.get("after"), "")));
                suggestion.put("reason", clean(Objects.toString(map.get("reason"), "")));
                suggestion.put("relatedRequirement", clean(Objects.toString(map.get("relatedRequirement"), "")));
                double confidence = map.get("confidence") instanceof Number number ? number.doubleValue() : 0.5d;
                suggestion.put("confidence", Math.max(0d, Math.min(1d, confidence)));
                List<String> evidence = stringList(map.get("evidence"));
                ResumeTailoringValidator.Validation validation = ResumeTailoringValidator.validate(
                    resumeText, candidate, jobDescription, suggestion.get("before").toString(),
                    suggestion.get("after").toString(), evidence, confirmedFacts);
                if (validation.valid()) {
                    suggestion.put("evidence", evidence);
                    suggestion.put("validation", "verified");
                    suggestion.put("safeToApply", true);
                    normalized.add(suggestion);
                } else {
                    rejectedCount++;
                    suggestion.put("evidence", evidence);
                    suggestion.put("validation", "rejected");
                    suggestion.put("safeToApply", false);
                    suggestion.put("validationReason", validation.reason());
                    rejected.add(suggestion);
                }
            }
        }
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("suggestions", normalized);
        result.put("rejectedSuggestions", rejected);
        List<String> cautions = new ArrayList<>(stringList(raw.get("cautions")));
        if (rejectedCount > 0) cautions.add(rejectedCount + " proposed edit(s) were withheld because their source or evidence could not be verified.");
        result.put("cautions", cautions);
        result.put("validation", Map.of("status", rejectedCount == 0 ? "passed" : "partial", "acceptedEdits", normalized.size(), "rejectedEdits", rejectedCount));
        result.put("model", model);
        result.put("degraded", degraded);
        result.put("cached", false);
        writeCache(key, "suggestions", result);
        return result;
    }

    public Map<String, Object> applicationAnswers(String resumeText, String jobDescription,
                                                   List<Map<String, Object>> questions, String suppliedHash) {
        if (resumeText == null || resumeText.isBlank()) throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Resume text is required.");
        if (questions == null || questions.isEmpty()) throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "No application questions were provided.");
        List<Map<String, Object>> normalizedQuestions = new ArrayList<>();
        for (Map<String, Object> question : questions.stream().limit(20).toList()) {
            if (question == null) continue;
            String id = clean(Objects.toString(question.get("id"), "question-" + normalizedQuestions.size()));
            String label = clean(Objects.toString(question.get("question"), ""));
            if (label.isBlank()) continue;
            List<String> options = question.get("options") instanceof List<?> values
                ? values.stream().limit(20).map(value -> clean(Objects.toString(value, ""))).filter(value -> !value.isBlank()).toList()
                : List.of();
            normalizedQuestions.add(Map.of("id", id, "question", label.substring(0, Math.min(400, label.length())), "options", options));
        }
        if (normalizedQuestions.isEmpty()) throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "No readable application questions were provided.");
        String resume = clean(resumeText);
        String jd = trimJobDescription(jobDescription == null ? "" : jobDescription);
        String resumeHash = validHash(suppliedHash) ? suppliedHash : sha256(resume);
        String key = cacheKey(resumeHash, jd + "\n" + json(normalizedQuestions), ANSWER_VERSION);
        Map<String, Object> cached = readCache(key, "application-answers");
        if (cached != null) { cached.put("cached", true); return cached; }

        String prompt = """
            Draft concise, professional, candidate-aligned answers to these job application questions based on the candidate's resume and the job description.
            For factual questions (experience years, specific tools, degrees, graduation year, location, salary), use only facts present in the resume.
            For open-ended questions (e.g. why pursue this career, interest in web development / software engineering, why join this company, strengths, work style, career goals):
            ALWAYS generate a high-quality, articulate, professional answer (2-4 concise sentences) tailored to the candidate's actual skills, projects, and the target role from the job description. Do NOT leave open-ended or career interest questions blank!
            For sensitive legal or demographic questions (criminal record, disability, caste, race, religion), return empty with needsUserInput=true.
            Return one result per question with its exact id, answer, confidence (low|medium|high), and needsUserInput boolean. When a question has choices, return the exact text of one choice only if resume facts clearly support it; otherwise return blank.
            RESUME FACTS:\n%s\nJOB DESCRIPTION:\n%s\nQUESTIONS:\n%s
            """.formatted(resume, jd, json(normalizedQuestions));
        Map<String, Object> raw = callGemini(prompt, applicationAnswersSchema(), 800, false);
        boolean degraded = Boolean.TRUE.equals(raw.remove("_menixDegraded"));
        Map<String, Map<String, Object>> byId = new LinkedHashMap<>();
        Object returned = raw.get("answers");
        if (returned instanceof List<?> items) for (Object item : items) {
            if (!(item instanceof Map<?, ?> map)) continue;
            String id = clean(Objects.toString(map.get("id"), ""));
            if (id.isBlank()) continue;
            String confidence = clean(Objects.toString(map.get("confidence"), "low")).toLowerCase();
            if (!List.of("low", "medium", "high").contains(confidence)) confidence = "low";
            Map<String, Object> answer = new LinkedHashMap<>();
            answer.put("id", id);
            answer.put("answer", clean(Objects.toString(map.get("answer"), "")));
            answer.put("confidence", confidence);
            answer.put("needsUserInput", Boolean.TRUE.equals(map.get("needsUserInput")) || clean(Objects.toString(map.get("answer"), "")).isBlank());
            byId.put(id, answer);
        }
        List<Map<String, Object>> answers = new ArrayList<>();
        for (Map<String, Object> question : normalizedQuestions) {
            String id = Objects.toString(question.get("id"));
            Map<String, Object> answer = byId.get(id);
            if (answer == null) answer = Map.of("id", id, "answer", "", "confidence", "low", "needsUserInput", true);
            answers.add(answer);
        }
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("answers", answers);
        result.put("model", model);
        result.put("degraded", degraded);
        result.put("cached", false);
        writeCache(key, "application-answers", result);
        return result;
    }

    public Map<String, Object> legacyReview(OverviewRequest request) {
        Map<String, Object> overview = overview(request);
        Map<String, Object> review = new LinkedHashMap<>();
        review.put("matchSummary", overview.get("verdict"));
        review.put("matchScore", overview.get("matchScore"));
        review.put("matchLevel", overview.get("matchLevel"));
        Map<String, Object> scores = asMap(overview.get("scores"));
        review.put("skillsMatchScore", scores.get("skills"));
        review.put("experienceMatchScore", scores.get("experience"));
        review.put("keywordMatchScore", scores.get("keywords"));
        review.put("matchedSkills", asMap(overview.get("matchedSkills")).getOrDefault("technical", List.of()));
        review.put("missingSkills", overview.get("missingSkills"));
        review.put("supportedKeywords", overview.get("missingKeywords"));
        review.put("gapsToVerify", List.of());
        Map<String, Object> suggestions = suggestions(new SuggestionsRequest(request.resumeProfile(), request.resumeText(),
            request.jobDescription(), request.jobMeta(), null, request.resumeHash()));
        List<String> rewrites = new ArrayList<>();
        for (Object item : (List<?>) suggestions.getOrDefault("suggestions", List.of())) {
            if (item instanceof Map<?, ?> map) rewrites.add(Objects.toString(map.get("after"), ""));
        }
        review.put("suggestedSummary", rewrites.isEmpty() ? "" : rewrites.get(0));
        review.put("rewrittenBullets", rewrites.size() < 2 ? List.of() : rewrites.subList(1, rewrites.size()));
        review.put("cautions", suggestions.getOrDefault("cautions", List.of()));
        try {
            String text = mapper.writeValueAsString(review);
            Map<String, Object> envelope = Map.of("candidates", List.of(Map.of("content", Map.of("parts", List.of(Map.of("text", text))))));
            return Map.of("model", model, "review", envelope, "degraded", Boolean.TRUE.equals(overview.get("degraded")) || Boolean.TRUE.equals(suggestions.get("degraded")),
                "notice", "AI suggestions only. Verify every statement and approve edits before using them.");
        } catch (Exception ex) {
            throw new IllegalStateException("Could not serialize the compatibility analysis response.", ex);
        }
    }

    @Scheduled(cron = "0 15 3 * * *")
    public void cleanupExpiredCache() {
        cacheRepository.deleteByCreatedAtBefore(LocalDateTime.now().minusDays(7));
    }

    private void createProfileIfAbsent(String hash, String resumeText) {
        if (apiKey == null || apiKey.isBlank() || !profilesInFlight.add(hash)) return;
        try {
            if (profileRepository.existsById(hash)) return;
            String prompt = "Extract only facts explicitly present in this resume. Return skills (technical skills only), yearsExperience (number or null), degree, location, projects (strings), and roles (strings including dates when visible). Resume:\\n" + resumeText;
            Map<String, Object> extracted = callGemini(prompt, profileSchema(), 500, false);
            extracted.remove("_menixDegraded");
            profileRepository.save(new ResumeProfile(hash, json(extracted)));
        } catch (Exception ex) {
            log.info("Resume profile extraction was unavailable; raw text remains the fallback.");
        } finally {
            profilesInFlight.remove(hash);
        }
    }

    private String overviewPrompt(String candidateEvidence, String jd, Map<String, Object> jobMeta) {
        return """
            Analyze any job family dynamically; do not assume a developer role or use a role-specific fixed skill list.
            Extract the role family, industry and seniority from this job description. Extract distinct requirements
            into the requirements array. Categorize each as REQUIRED_SKILL, PREFERRED_SKILL, EXPERIENCE,
            PROJECT_RESPONSIBILITY, KEYWORD, EDUCATION_CERTIFICATION, or ELIGIBILITY; importance is MUST_HAVE,
            PREFERRED, OPTIONAL, RESPONSIBILITY, EDUCATION, EXPERIENCE, CERTIFICATION, or ELIGIBILITY.
            Classify each against the resume as EXACT_MATCH, EQUIVALENT_MATCH, RELATED_EXPERIENCE, MISSING, or UNKNOWN.
            Every supported match must quote a short exact evidence excerpt from the resume and identify its section.
            A skill name alone does not prove work experience. Similar technologies are not interchangeable: React does
            not prove Angular, Spring Boot does not prove Node.js, and Docker does not prove Kubernetes. Only use
            RELATED_EXPERIENCE when the quoted resume evidence is relevant but does not prove the named requirement.
            Use UNKNOWN only when the resume/JD is incomplete enough that the match cannot be judged; otherwise use
            MISSING when no evidence exists. Never make up resume evidence, skills, dates, achievements or metrics.
            Do not duplicate the same requirement in different categories. Do not put location, work mode, notice
            period or work authorization in skills; put them in fitChecks. A related degree is equivalent unless the
            job says the degree is mandatory and exclusive. Parse years and compare dated roles conservatively.
            Only list concrete qualifications, technologies, tools, certifications, or explicit responsibilities
            stated in the job description. Never turn navigation/footer fragments, company legal suffixes, generic
            words, or scraped site labels (for example "connect", "time", "app", "Ltd", "privacy policy", or
            "careers") into requirements. If the description contains no concrete requirement, return an empty list.
            Do not calculate or return any score; Java validates evidence and calculates all scores.
            Return concise reasons (maximum 3), one-sentence verdict (maximum 20 words), and medium/low confidence
            when the JD is incomplete. Avoid generic skill lists and keyword stuffing.
            
            JOB METADATA: %s
            %s
            JOB DESCRIPTION:
            %s
            """.formatted(json(jobMeta), candidateEvidence, jd);
    }

    private Map<String, Object> normalizeOverview(Map<String, Object> source, String resumeEvidence, boolean resumeAvailable) {
        Map<String, Object> out = new LinkedHashMap<>();
        Map<String, Object> jobIdentity = new LinkedHashMap<>();
        jobIdentity.put("jobFamily", clean(Objects.toString(source.get("jobFamily"), "")));
        jobIdentity.put("industry", clean(Objects.toString(source.get("industry"), "")));
        jobIdentity.put("seniority", clean(Objects.toString(source.get("seniority"), "")));
        out.put("jobIdentity", jobIdentity);

        RequirementEvidenceMatcher.Result evidenceResult = RequirementEvidenceMatcher.evaluate(
            objectList(source.get("requirements")), resumeEvidence, jobIdentity.get("seniority").toString(), resumeAvailable);
        List<Map<String, Object>> requirements = evidenceResult.requirements();
        out.put("requirements", evidenceResult.requirements());
        out.put("requirementPriorities", requirementPriorities(evidenceResult.requirements()));
        out.put("scoreBreakdown", scoreBreakdown(evidenceResult));
        out.put("matchScore", evidenceResult.matchScore());
        out.put("atsAssessment", atsAssessment(requirements, evidenceResult, resumeEvidence, resumeAvailable));
        out.put("scoringVersion", "evidence-weighted-v1");
        out.put("scores", legacyScores(evidenceResult.breakdown()));
        out.put("confidence", enumValue(source.get("confidence"), List.of("low", "medium", "high"), "low"));
        out.put("verdict", limitWords(clean(Objects.toString(source.get("verdict"), "")), 20));
        out.put("reasons", stringList(source.get("reasons")).stream().limit(3).toList());
        Map<String, Object> matchedSkillsSource = asMap(source.get("matchedSkills"));
        out.put("matchedSkills", Map.of(
            "technical", requirementNames(requirements, Set.of("REQUIRED_SKILL", "PREFERRED_SKILL"), Set.of("EXACT_MATCH")),
            "soft", stringList(matchedSkillsSource.get("soft")).stream().filter(value -> containsResumeEvidence(resumeEvidence, value)).toList()));
        out.put("equivalentSkills", requirementEvidence(requirements, Set.of("EQUIVALENT_MATCH")));
        out.put("relatedSkills", requirementEvidence(requirements, Set.of("RELATED_EXPERIENCE")));
        out.put("missingSkills", requirementNames(requirements, Set.of("REQUIRED_SKILL"), Set.of("MISSING")));
        out.put("missingKeywords", requirementNames(requirements, Set.of("KEYWORD"), Set.of("MISSING")));
        out.put("scoreConfidence", scoreConfidence(requirements));
        out.put("fitChecks", objectList(source.get("fitChecks")));
        out.put("experience", source.get("experience") instanceof Map<?, ?> ? source.get("experience") : Map.of());
        return out;
    }

    private Map<String, List<Map<String, Object>>> requirementPriorities(List<Map<String, Object>> requirements) {
        Map<String, List<Map<String, Object>>> priorities = new LinkedHashMap<>();
        priorities.put("critical", new ArrayList<>());
        priorities.put("important", new ArrayList<>());
        priorities.put("preferred", new ArrayList<>());
        priorities.put("additional", new ArrayList<>());
        for (Map<String, Object> item : requirements) {
            String importance = Objects.toString(item.get("importance"), "OPTIONAL");
            String bucket = switch (importance) {
                case "MUST_HAVE" -> "critical";
                case "PREFERRED" -> "preferred";
                case "OPTIONAL" -> "additional";
                default -> "important";
            };
            priorities.get(bucket).add(item);
        }
        return priorities;
    }

    private Map<String, Object> atsAssessment(List<Map<String, Object>> requirements,
                                              RequirementEvidenceMatcher.Result result,
                                              String resumeText, boolean resumeAvailable) {
        List<Map<String, Object>> keywordRequirements = requirements.stream()
            .filter(item -> Set.of("REQUIRED_SKILL", "PREFERRED_SKILL", "KEYWORD").contains(item.get("category")))
            .filter(item -> !"UNKNOWN".equals(item.get("classification"))).toList();
        double keywordWeight = keywordRequirements.stream().mapToDouble(item -> importanceWeight(Objects.toString(item.get("importance"), "OPTIONAL"))).sum();
        double keywordCredit = keywordRequirements.stream().mapToDouble(item -> importanceWeight(Objects.toString(item.get("importance"), "OPTIONAL")) * switch (Objects.toString(item.get("classification"), "UNKNOWN")) {
            case "EXACT_MATCH" -> 1d; case "EQUIVALENT_MATCH" -> 0.9d; case "RELATED_EXPERIENCE" -> 0.5d; default -> 0d;
        }).sum();
        Integer keywordCoverage = keywordWeight == 0 ? null : (int) Math.round(100d * keywordCredit / keywordWeight);
        boolean hasExtractedText = resumeAvailable && !resumeText.stripLeading().startsWith("{") && !resumeText.stripLeading().startsWith("[");
        Integer readability = hasExtractedText ? readabilityEstimate(resumeText) : null;
        Map<String, Object> assessment = new LinkedHashMap<>();
        assessment.put("jobMatchScore", result.matchScore());
        assessment.put("keywordCoverageScore", keywordCoverage);
        assessment.put("atsReadabilityScore", readability);
        assessment.put("projectRelevanceScore", result.breakdown().get("projectsResponsibilities"));
        assessment.put("label", "Internal estimate; not an employer ATS score or hiring prediction.");
        assessment.put("readabilityNote", hasExtractedText
            ? "Heuristic based on extractable text, common section headings and basic contact details. Visual DOCX parsing can differ by ATS."
            : "Upload a resume to estimate parsing readability.");
        return assessment;
    }

    private double importanceWeight(String importance) {
        return switch (importance) {
            case "MUST_HAVE" -> 2d;
            case "PREFERRED" -> 1d;
            case "OPTIONAL" -> 0.5d;
            default -> 1.25d;
        };
    }

    private int readabilityEstimate(String text) {
        String value = clean(text);
        String lower = value.toLowerCase(Locale.ROOT);
        int score = 35;
        long headings = List.of("summary", "objective", "skills", "experience", "internship", "projects", "education", "certifications")
            .stream().filter(heading -> Pattern.compile("(?i)(?:^|\\b)" + Pattern.quote(heading) + "(?:\\b|$)").matcher(value).find()).count();
        score += (int) Math.min(35, headings * 7);
        int words = value.isBlank() ? 0 : value.split("\\s+").length;
        score += words >= 100 && words <= 900 ? 15 : words >= 50 ? 8 : 0;
        if (lower.matches("(?s).*\\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}\\b.*")) score += 8;
        if (Pattern.compile("(?<!\\d)\\+?\\d[\\d ()-]{7,}\\d(?!\\d)").matcher(value).find()) score += 7;
        return Math.max(0, Math.min(100, score));
    }

    private Map<String, Object> scoreBreakdown(RequirementEvidenceMatcher.Result result) {
        Map<String, Object> output = new LinkedHashMap<>();
        result.breakdown().forEach((category, score) -> output.put(category, Map.of(
            "score", score == null ? "" : score,
            "weight", result.weights().get(category),
            "available", score != null
        )));
        return output;
    }

    private Map<String, Object> legacyScores(Map<String, Integer> breakdown) {
        Map<String, Object> scores = new LinkedHashMap<>();
        scores.put("skills", average(breakdown.get("requiredSkills"), breakdown.get("preferredSkills")));
        scores.put("experience", breakdown.get("relevantExperience"));
        scores.put("keywords", breakdown.get("keywords"));
        scores.put("education", breakdown.get("educationCertifications"));
        return scores;
    }

    private Integer average(Integer first, Integer second) {
        if (first == null) return second;
        if (second == null) return first;
        return (int) Math.round((first + second) / 2d);
    }

    private List<String> requirementNames(List<Map<String, Object>> requirements, Set<String> categories, Set<String> classifications) {
        return requirements.stream().filter(item -> categories.contains(Objects.toString(item.get("category"))))
            .filter(item -> classifications.contains(Objects.toString(item.get("classification"))))
            .map(item -> Objects.toString(item.get("name"), "")).filter(value -> !value.isBlank()).distinct().toList();
    }

    private List<Map<String, Object>> requirementEvidence(List<Map<String, Object>> requirements, Set<String> classifications) {
        return requirements.stream().filter(item -> classifications.contains(Objects.toString(item.get("classification"))))
            .filter(item -> !Objects.toString(item.get("evidence"), "").isBlank())
            .map(item -> Map.<String, Object>of("required", Objects.toString(item.get("name")), "evidence", Objects.toString(item.get("evidence")), "classification", Objects.toString(item.get("classification"))))
            .toList();
    }

    private String scoreConfidence(List<Map<String, Object>> requirements) {
        if (requirements.isEmpty()) return "low";
        long judged = requirements.stream().filter(item -> !"UNKNOWN".equals(item.get("classification"))).count();
        double completeness = (double) judged / requirements.size();
        return completeness >= 0.85 ? "high" : completeness >= 0.55 ? "medium" : "low";
    }

    private boolean containsResumeEvidence(String resume, String claim) {
        String haystack = clean(resume).toLowerCase();
        String needle = clean(claim).toLowerCase();
        return !needle.isBlank() && haystack.contains(needle);
    }

    private Map<String, Object> callGemini(String prompt, Map<String, Object> schema, int maxTokens, boolean overview) {
        if (apiKey == null || apiKey.isBlank()) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "Gemini API key is not configured on the backend. Set GEMINI_API_KEY and restart.");
        }
        Map<String, Object> generation = generationConfig(schema, maxTokens, true, true, overview);
        Map<String, Object> payload = buildGeminiRequest(prompt, generation);
        boolean degraded = false;
        boolean transientRetryUsed = false;
        while (true) {
            try {
                byte[] responseBody = restClient.post().uri(geminiUrl()).contentType(MediaType.APPLICATION_JSON)
                    .body(payload).retrieve().body(byte[].class);
                if (responseBody == null || responseBody.length == 0) {
                    throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, "The AI provider returned an empty analysis. Please retry.");
                }
                // Some Gemini/API gateway responses use application/octet-stream even when
                // the payload is JSON. Decode bytes explicitly instead of asking the HTTP
                // message converters to deserialize that media type directly into a Map.
                JsonNode envelope = mapper.readTree(responseBody);
                JsonNode node = envelope.path("candidates").path(0).path("content").path("parts").path(0).path("text");
                if (!node.isTextual()) throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, "The AI provider returned an empty analysis. Please retry.");
                Map<String, Object> result = mapper.readValue(node.asText(), new TypeReference<>() {});
                if (degraded) result.put("_menixDegraded", true);
                return result;
            } catch (RestClientResponseException ex) {
                int status = ex.getStatusCode().value();
                String responseBody = redactSecrets(ex.getResponseBodyAsString());
                logGeminiFailure(status, responseBody, generation);
                if (status == 400 && !degraded && (generation.containsKey("responseSchema") || generation.containsKey("thinkingConfig"))) {
                    if (generation.containsKey("responseSchema")) log.warn("Retrying Gemini request after dropping responseSchema (model={})", model);
                    if (generation.containsKey("thinkingConfig")) log.warn("Retrying Gemini request after dropping thinkingConfig (model={})", model);
                    generation = generationConfig(schema, maxTokens, true, false, false);
                    payload = buildGeminiRequest(prompt, generation);
                    degraded = true;
                    continue;
                }
                if (!transientRetryUsed && (status == 429 || status == 503)) {
                    transientRetryUsed = true;
                    try { Thread.sleep(250); } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
                    continue;
                }
                String message = switch (status) {
                    case 400 -> "The AI provider rejected the analysis request. Check the configured Gemini model and request settings.";
                    case 401, 403 -> "The AI provider rejected the configured credentials. Check the Gemini API key on the backend.";
                    case 429 -> "The AI provider is temporarily rate-limited. Please wait and try again.";
                    default -> "The AI provider could not complete the analysis. Please try again later.";
                };
                throw new ResponseStatusException(status == 429 || status == 503 ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.BAD_GATEWAY, message);
            } catch (RestClientException ex) {
                log.warn("Gemini analysis request could not reach the provider (model={}, error={}): {}",
                    model, ex.getClass().getSimpleName(), redactSecrets(Objects.toString(ex.getMessage(), "")));
                throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, "The AI provider could not be reached. Please try again later.");
            } catch (Exception ex) {
                if (ex instanceof ResponseStatusException responseStatusException) throw responseStatusException;
                log.warn("Gemini returned invalid JSON for the analysis response", ex);
                throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, "The AI provider returned an invalid analysis. Please retry.");
            }
        }
    }

    Map<String, Object> generationConfig(Map<String, Object> schema, int maxTokens,
                                                  boolean jsonMime, boolean includeSchema, boolean includeThinking) {
        Map<String, Object> generation = new LinkedHashMap<>();
        if (jsonMime) generation.put("responseMimeType", "application/json");
        if (includeSchema) generation.put("responseSchema", schema);
        // Gemini 3.x deprecates sampling controls; sending temperature can cause a 400.
        if (!model.startsWith("gemini-3.")) generation.put("temperature", 0.2);
        generation.put("maxOutputTokens", Math.min(Math.max(maxTokens, 1), 8192));
        if (includeThinking && supportsThinkingBudgetZero(model)) {
            generation.put("thinkingConfig", Map.of("thinkingBudget", 0));
        }
        return generation;
    }

    private boolean supportsThinkingBudgetZero(String modelName) {
        return "gemini-2.5-flash".equals(modelName) || "gemini-2.5-flash-lite".equals(modelName);
    }

    Map<String, Object> buildGeminiRequest(String prompt, Map<String, Object> generationConfig) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("contents", List.of(Map.of("parts", List.of(Map.of("text", prompt)))));
        if (generationConfig != null && !generationConfig.isEmpty()) body.put("generationConfig", generationConfig);
        return body;
    }

    private String geminiUrl() {
        return "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + apiKey;
    }

    private String redactSecrets(String text) {
        if (text == null) return "";
        String safe = apiKey == null || apiKey.isBlank() ? text : text.replace(apiKey, "[redacted]");
        return safe.replaceAll("(?i)(key=)[^&\\s\\\"]+", "$1[redacted]")
            .replaceAll("(?i)(password[=: ]+)[^,\\s\\\"]+", "$1[redacted]");
    }

    private void logGeminiFailure(int status, String body, Map<String, Object> generation) {
        Object thinking = generation.getOrDefault("thinkingConfig", "not sent");
        log.warn("Gemini request failed status={} model={} generationConfigOptions={} thinkingConfig={} providerError={}",
            status, model, generation.keySet(), thinking, body);
    }

    public Map<String, Object> runDiagnostics() {
        Map<String, Object> checks = new LinkedHashMap<>();
        Map<String, Object> tinySchema = Map.of("type", "OBJECT", "properties", Map.of("ok", Map.of("type", "BOOLEAN")), "required", List.of("ok"));
        checks.put("plain", diagnosticCall("plain", Map.of()));
        checks.put("jsonMime", diagnosticCall("jsonMime", Map.of("responseMimeType", "application/json")));
        if (supportsThinkingBudgetZero(model)) {
            checks.put("thinkingBudgetZero", diagnosticCall("thinkingBudgetZero", Map.of("thinkingConfig", Map.of("thinkingBudget", 0))));
        } else {
            checks.put("thinkingBudgetZero", Map.of("status", "FAIL", "message", "Not sent: thinkingBudget=0 is unsupported for configured model " + model));
        }
        checks.put("schema", diagnosticCall("schema", Map.of("responseMimeType", "application/json", "responseSchema", tinySchema)));
        return Map.of("model", model, "checks", checks);
    }

    private Map<String, String> diagnosticCall(String testName, Map<String, Object> generation) {
        if (apiKey == null || apiKey.isBlank()) return Map.of("status", "FAIL", "message", "GEMINI_API_KEY is not configured.");
        Map<String, Object> payload = buildGeminiRequest("Return the word OK.", generation);
        try {
            restClient.post().uri(geminiUrl()).contentType(MediaType.APPLICATION_JSON).body(payload).retrieve().body(byte[].class);
            return Map.of("status", "OK", "message", "Provider accepted this request configuration.");
        } catch (RestClientResponseException ex) {
            String body = redactSecrets(ex.getResponseBodyAsString());
            log.warn("Gemini diagnostic failed test={} status={} model={} generationConfigOptions={} providerError={}",
                testName, ex.getStatusCode().value(), model, generation.keySet(), body);
            String providerMessage;
            try { providerMessage = mapper.readTree(body).path("error").path("message").asText(body); }
            catch (Exception ignored) { providerMessage = body; }
            return Map.of("status", "FAIL", "message", providerMessage);
        } catch (RestClientException ex) {
            return Map.of("status", "FAIL", "message", "Provider request failed: " + ex.getClass().getSimpleName());
        }
    }

    Map<String, Object> overviewSchema() {
        return objectSchema(Map.ofEntries(
            Map.entry("jobFamily", stringSchema()), Map.entry("industry", stringSchema()), Map.entry("seniority", stringSchema()),
            Map.entry("confidence", enumSchema("low", "medium", "high")), Map.entry("verdict", stringSchema()),
            Map.entry("reasons", arraySchema(stringSchema())),
            Map.entry("matchedSkills", objectSchema(Map.of("technical", arraySchema(stringSchema()), "soft", arraySchema(stringSchema())))),
            Map.entry("requirements", arraySchema(objectSchema(Map.of(
                "name", stringSchema(),
                "category", enumSchema("REQUIRED_SKILL", "PREFERRED_SKILL", "EXPERIENCE", "PROJECT_RESPONSIBILITY", "KEYWORD", "EDUCATION_CERTIFICATION", "ELIGIBILITY"),
                "importance", enumSchema("MUST_HAVE", "PREFERRED", "OPTIONAL", "RESPONSIBILITY", "EDUCATION", "EXPERIENCE", "CERTIFICATION", "ELIGIBILITY"),
                "classification", enumSchema("EXACT_MATCH", "EQUIVALENT_MATCH", "RELATED_EXPERIENCE", "MISSING", "UNKNOWN"),
                "evidence", stringSchema(),
                "evidenceSection", enumSchema("SKILLS", "EXPERIENCE", "INTERNSHIP", "PROJECTS", "EDUCATION", "CERTIFICATIONS", "ACHIEVEMENTS", "OTHER", "UNKNOWN"),
                "confidence", enumSchema("low", "medium", "high"), "explanation", stringSchema()
            )))),
            Map.entry("equivalentSkills", arraySchema(objectSchema(Map.of("required", stringSchema(), "evidence", stringSchema())))),
            Map.entry("missingSkills", arraySchema(stringSchema())), Map.entry("missingKeywords", arraySchema(stringSchema())),
            Map.entry("fitChecks", arraySchema(objectSchema(Map.of("type", enumSchema("location", "education", "experience", "workMode", "noticePeriod", "employmentType", "seniority", "certification", "workAuthorization", "industry"), "required", stringSchema(), "candidate", stringSchema(), "status", enumSchema("ok", "warn", "gap"), "note", stringSchema())))),
            Map.entry("experience", objectSchema(Map.of("requiredMin", nullableNumber(), "requiredMax", nullableNumber(), "candidateYears", nullableNumber(), "note", stringSchema())))
        ));
    }

    private Map<String, Object> suggestionsSchema() {
        return objectSchema(Map.of("suggestions", arraySchema(objectSchema(Map.ofEntries(
            Map.entry("id", stringSchema()), Map.entry("section", enumSchema("summary", "bullet", "skills", "project", "experience", "achievement")),
            Map.entry("before", stringSchema()), Map.entry("after", stringSchema()), Map.entry("reason", stringSchema()),
            Map.entry("relatedRequirement", stringSchema()), Map.entry("evidence", arraySchema(stringSchema())),
            Map.entry("confidence", Map.of("type", "NUMBER", "minimum", 0, "maximum", 1))
        ))), "cautions", arraySchema(stringSchema())));
    }
    private Map<String, Object> applicationAnswersSchema() {
        return objectSchema(Map.of("answers", arraySchema(objectSchema(Map.of(
            "id", stringSchema(), "answer", stringSchema(), "confidence", enumSchema("low", "medium", "high"),
            "needsUserInput", Map.of("type", "BOOLEAN")
        )))));
    }
    private Map<String, Object> profileSchema() {
        return objectSchema(Map.of("skills", arraySchema(stringSchema()), "yearsExperience", nullableNumber(), "degree", stringSchema(), "location", stringSchema(), "projects", arraySchema(stringSchema()), "roles", arraySchema(stringSchema())));
    }
    private Map<String, Object> objectSchema(Map<String, Object> props) { return Map.of("type", "OBJECT", "properties", props); }
    private Map<String, Object> stringSchema() { return Map.of("type", "STRING"); }
    private Map<String, Object> nullableInteger() { return Map.of("type", "INTEGER", "nullable", true, "minimum", 0, "maximum", 100); }
    private Map<String, Object> nullableNumber() { return Map.of("type", "NUMBER", "nullable", true, "minimum", 0); }
    private Map<String, Object> arraySchema(Map<String, Object> item) { return Map.of("type", "ARRAY", "items", item); }
    private Map<String, Object> arraySchema(Map<String, Object> item, boolean nullable) { return arraySchema(item); }
    private Map<String, Object> enumSchema(String... values) { return Map.of("type", "STRING", "enum", List.of(values)); }

    private String trimJobDescription(String value) {
        String text = value.replaceAll("(?im)^\\s*(?:about (?:the )?company|walk[- ]in (?:details|interview)|follow us|connect with us|privacy policy|terms of use)\\b.*$", " ");
        text = text.replaceAll("(?im)^\\s*(?:home|jobs|login|sign up|download app)\\s*(?:\\|.*)?$", " ");
        text = text.replaceAll("\\s+", " ").trim();
        return text.length() > 6000 ? text.substring(0, 6000) : text;
    }
    private String cacheKey(String hash, String jd, String version) { return sha256(hash + "\n" + normalize(jd) + "\n" + model + "\n" + version); }
    private boolean validHash(String value) { return value != null && value.matches("(?i)[a-f0-9]{64}"); }
    private String normalize(String value) { return clean(value).toLowerCase().replaceAll("[^a-z0-9]+", " ").trim(); }
    private String sha256(String value) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))); }
        catch (Exception ex) { throw new IllegalStateException("SHA-256 is unavailable.", ex); }
    }
    private Map<String, Object> readCache(String key, String kind) {
        AnalysisCache cache = cacheRepository.findByCacheKeyAndKind(key, kind).orElse(null);
        if (cache == null) return null;
        if (cache.getCreatedAt().isBefore(LocalDateTime.now().minusDays(7))) { cacheRepository.delete(cache); return null; }
        return readObject(cache.getJson());
    }
    private void writeCache(String key, String kind, Map<String, Object> value) { cacheRepository.save(new AnalysisCache(key, kind, json(value))); }
    private String json(Object value) {
        try { return mapper.writeValueAsString(value == null ? Map.of() : value); }
        catch (Exception ex) { throw new IllegalStateException("Could not serialize analysis data.", ex); }
    }
    private Map<String, Object> readObject(String value) {
        try { return mapper.readValue(value, new TypeReference<>() {}); }
        catch (Exception ex) { return new LinkedHashMap<>(); }
    }
    private Map<String, Object> asMap(Object value) {
        if (value instanceof Map<?, ?> map) {
            Map<String, Object> result = new LinkedHashMap<>();
            map.forEach((key, item) -> result.put(Objects.toString(key), item));
            return result;
        }
        return new LinkedHashMap<>();
    }
    private List<String> stringList(Object value) {
        if (!(value instanceof List<?> list)) return List.of();
        return list.stream().filter(Objects::nonNull).map(Object::toString).map(String::trim).filter(v -> !v.isBlank()).toList();
    }
    private List<Map<String, Object>> objectList(Object value) {
        if (!(value instanceof List<?> list)) return List.of();
        List<Map<String, Object>> output = new ArrayList<>();
        for (Object item : list) if (item instanceof Map<?, ?> map) output.add(asMap(map));
        return output;
    }
    private String enumValue(Object value, List<String> values, String fallback) { String text = Objects.toString(value, "").toLowerCase(); return values.contains(text) ? text : fallback; }
    private String limitWords(String text, int max) { String[] words = text.split("\\s+"); return words.length <= max ? text : String.join(" ", java.util.Arrays.copyOf(words, max)); }
    private String clean(String value) { return value == null ? "" : value.replaceAll("\\s+", " ").trim(); }
    private void validate(String jd, String resumeText, Map<String, Object> resumeProfile) {
        if (jd == null || jd.isBlank() || ((resumeText == null || resumeText.isBlank()) && (resumeProfile == null || resumeProfile.isEmpty()))) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Resume profile or text and job description are required.");
        }
    }
}
