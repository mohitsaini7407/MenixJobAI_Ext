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
import java.util.Objects;
import java.util.concurrent.CompletableFuture;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
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
    private static final String PROMPT_VERSION = "overview-v2";
    private static final String SUGGESTION_VERSION = "suggestions-v1";
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
                                     String workingResume, String resumeHash) {}

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
        String candidateEvidence = profile != null && !profile.isEmpty()
            ? "STRUCTURED RESUME PROFILE:\n" + json(profile)
            : "RESUME TEXT:\n" + resumeText;
        String prompt = overviewPrompt(candidateEvidence, jobDescription, jobMeta);
        Map<String, Object> raw = callGemini(prompt, overviewSchema(), 700, true);
        boolean degraded = Boolean.TRUE.equals(raw.remove("_menixDegraded"));
        Map<String, Object> result = normalizeOverview(raw);
        Integer score = AnalysisScoring.total(asMap(result.get("scores")));
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
        String key = cacheKey(resumeHash, jobDescription, SUGGESTION_VERSION);
        Map<String, Object> cached = readCache(key, "suggestions");
        if (cached != null) { cached.put("cached", true); return cached; }

        String candidate = request.workingResume() != null && !request.workingResume().isBlank()
            ? request.workingResume() : resumeText;
        String prompt = """
            Suggest only truthful, evidence-supported resume edits for this job. Do not add skills,
            employers, dates, achievements, metrics, qualifications, or experience not present in
            the resume. Return JSON with suggestions (array of {id,section,before,after,reason})
            and cautions (array of strings). Sections must be summary, bullet, or skills. Return at
            most 6 edits, each concise. Keep each before excerpt exact so it can be found in the resume.
            RESUME:\n%s\nJOB DESCRIPTION:\n%s
            """.formatted(candidate, jobDescription);
        Map<String, Object> raw = callGemini(prompt, suggestionsSchema(), 900, false);
        boolean degraded = Boolean.TRUE.equals(raw.remove("_menixDegraded"));
        List<Map<String, Object>> normalized = new ArrayList<>();
        Object items = raw.get("suggestions");
        if (items instanceof List<?> list) {
            for (Object item : list) {
                if (!(item instanceof Map<?, ?> map)) continue;
                Map<String, Object> suggestion = new LinkedHashMap<>();
                suggestion.put("id", clean(Objects.toString(map.get("id"), "suggestion-" + normalized.size())));
                String section = clean(Objects.toString(map.get("section"), "bullet"));
                suggestion.put("section", List.of("summary", "bullet", "skills").contains(section) ? section : "bullet");
                suggestion.put("before", clean(Objects.toString(map.get("before"), "")));
                suggestion.put("after", clean(Objects.toString(map.get("after"), "")));
                suggestion.put("reason", clean(Objects.toString(map.get("reason"), "")));
                if (!suggestion.get("after").toString().isBlank()) normalized.add(suggestion);
            }
        }
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("suggestions", normalized);
        result.put("cautions", stringList(raw.get("cautions")));
        result.put("model", model);
        result.put("degraded", degraded);
        result.put("cached", false);
        writeCache(key, "suggestions", result);
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
            Compare candidate evidence with the job description conservatively. Never invent any fact.
            Compute component scores from explicit evidence, but do NOT return or calculate an overall
            match score. Related degrees (for example Data Science for Computer Science or related)
            count as equivalent unless the job says only. Put location, work mode, notice period and
            education in fitChecks, never missingSkills. missingSkills contains only explicit technical
            requirements absent from the resume. Separate technical and soft skills. Do not put soft
            skills in missingSkills. Avoid generic soft skills and synonyms that are not explicit in
            the JD. Parse required experience years and compare with dated resume roles. Give a numeric
            experience score whenever the JD states a years requirement; use null only when it states
            no experience requirement. Give null education only when the JD has no education criteria.
            Use null for skills or keywords only when the JD has no explicit requirements to score.
            Use null for candidateYears only if the resume has no usable dates or duration evidence.
            Confidence reflects JD completeness.
            Return one-sentence verdict of at most 20 words and at most 3 short reasons.
            
            JOB METADATA: %s
            %s
            JOB DESCRIPTION:
            %s
            """.formatted(json(jobMeta), candidateEvidence, jd);
    }

    private Map<String, Object> normalizeOverview(Map<String, Object> source) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("scores", AnalysisScoring.normalizeScores(asMap(source.get("scores"))));
        out.put("confidence", enumValue(source.get("confidence"), List.of("low", "medium", "high"), "low"));
        out.put("verdict", limitWords(clean(Objects.toString(source.get("verdict"), "")), 20));
        out.put("reasons", stringList(source.get("reasons")).stream().limit(3).toList());
        Map<String, Object> matched = asMap(source.get("matchedSkills"));
        out.put("matchedSkills", Map.of("technical", stringList(matched.get("technical")), "soft", stringList(matched.get("soft"))));
        out.put("equivalentSkills", objectList(source.get("equivalentSkills")));
        out.put("missingSkills", stringList(source.get("missingSkills")));
        out.put("missingKeywords", stringList(source.get("missingKeywords")));
        out.put("fitChecks", objectList(source.get("fitChecks")));
        out.put("experience", source.get("experience") instanceof Map<?, ?> ? source.get("experience") : Map.of());
        return out;
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
                Map<?, ?> envelope = restClient.post().uri(geminiUrl()).contentType(MediaType.APPLICATION_JSON).body(payload).retrieve().body(Map.class);
                JsonNode node = mapper.valueToTree(envelope).path("candidates").path(0).path("content").path("parts").path(0).path("text");
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
            restClient.post().uri(geminiUrl()).contentType(MediaType.APPLICATION_JSON).body(payload).retrieve().body(Map.class);
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
            Map.entry("scores", objectSchema(Map.of("skills", nullableInteger(), "experience", nullableInteger(), "keywords", nullableInteger(), "education", nullableInteger()))),
            Map.entry("confidence", enumSchema("low", "medium", "high")), Map.entry("verdict", stringSchema()),
            Map.entry("reasons", arraySchema(stringSchema())),
            Map.entry("matchedSkills", objectSchema(Map.of("technical", arraySchema(stringSchema()), "soft", arraySchema(stringSchema())))),
            Map.entry("equivalentSkills", arraySchema(objectSchema(Map.of("required", stringSchema(), "evidence", stringSchema())))),
            Map.entry("missingSkills", arraySchema(stringSchema())), Map.entry("missingKeywords", arraySchema(stringSchema())),
            Map.entry("fitChecks", arraySchema(objectSchema(Map.of("type", enumSchema("location", "education", "experience", "workMode", "noticePeriod"), "required", stringSchema(), "candidate", stringSchema(), "status", enumSchema("ok", "warn", "gap"), "note", stringSchema())))),
            Map.entry("experience", objectSchema(Map.of("requiredMin", nullableNumber(), "requiredMax", nullableNumber(), "candidateYears", nullableNumber(), "note", stringSchema())))
        ));
    }

    private Map<String, Object> suggestionsSchema() {
        return objectSchema(Map.of("suggestions", arraySchema(objectSchema(Map.of("id", stringSchema(), "section", enumSchema("summary", "bullet", "skills"), "before", stringSchema(), "after", stringSchema(), "reason", stringSchema()))), "cautions", arraySchema(stringSchema())));
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
