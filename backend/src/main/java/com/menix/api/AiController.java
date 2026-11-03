package com.menix.api;

import com.menix.service.AiAnalysisService;
import java.util.Map;
import java.util.List;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/api/ai")
public class AiController {
    private final AiAnalysisService analysisService;

    public AiController(AiAnalysisService analysisService) {
        this.analysisService = analysisService;
    }

    public record TailorRequest(String resumeText, String jobDescription) {}
    public record ProfileRequest(String resumeText) {}
    public record ApplicationAnswersRequest(String resumeText, String jobDescription, List<Map<String, Object>> questions, String resumeHash) {}

    @PostMapping("/overview")
    public Map<String, Object> overview(@RequestBody AiAnalysisService.OverviewRequest request) {
        return analysisService.overview(request);
    }

    @PostMapping("/suggestions")
    public Map<String, Object> suggestions(@RequestBody AiAnalysisService.SuggestionsRequest request) {
        return analysisService.suggestions(request);
    }

    @PostMapping("/application-answers")
    public Map<String, Object> applicationAnswers(@RequestBody ApplicationAnswersRequest request) {
        return analysisService.applicationAnswers(request == null ? null : request.resumeText(),
            request == null ? null : request.jobDescription(), request == null ? null : request.questions(),
            request == null ? null : request.resumeHash());
    }

    @PostMapping("/profile")
    public Map<String, Object> profile(@RequestBody ProfileRequest request) {
        return analysisService.queueResumeProfile(request == null ? null : request.resumeText());
    }

    @GetMapping("/diagnostics")
    public Map<String, Object> diagnostics(@RequestHeader(value = "X-Diagnostics-Token", required = false) String token) {
        if (!analysisService.authorizeDiagnostics(token)) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "A valid diagnostics admin token is required.");
        }
        return analysisService.runDiagnostics();
    }

    /** @deprecated Compatibility endpoint; new clients should call overview and suggestions. */
    @Deprecated
    @PostMapping("/tailor-review")
    public Map<String, Object> tailorReview(@RequestBody TailorRequest request) {
        return analysisService.legacyReview(new AiAnalysisService.OverviewRequest(
            null, request == null ? null : request.resumeText(),
            request == null ? null : request.jobDescription(), Map.of(), null));
    }
}
