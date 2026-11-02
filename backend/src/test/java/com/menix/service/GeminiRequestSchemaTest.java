package com.menix.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.menix.repo.AnalysisCacheRepository;
import com.menix.repo.ResumeProfileRepository;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.web.client.RestClient;

import java.util.Set;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.mock;

class GeminiRequestSchemaTest {
    @Test
    void serializedGeminiSchemaContainsNoForbiddenJsonSchemaConstructs() throws Exception {
        ObjectMapper mapper = new ObjectMapper();
        AiAnalysisService service = new AiAnalysisService(RestClient.create(), mapper,
            mock(AnalysisCacheRepository.class), mock(ResumeProfileRepository.class));
        ReflectionTestUtils.setField(service, "model", "gemini-2.5-flash");
        JsonNode request = mapper.valueToTree(service.buildGeminiRequest("tiny prompt",
            service.generationConfig(service.overviewSchema(), 700, true, true, true)));

        assertEquals("application/json", request.path("generationConfig").path("responseMimeType").asText());
        assertEquals(0, request.path("generationConfig").path("thinkingConfig").path("thinkingBudget").asInt());
        assertNoForbiddenKeysOrUnionTypes(request.path("generationConfig").path("responseSchema"));
    }

    @Test
    void gemini35FlashLiteOmitsDeprecatedSamplingAndThinkingBudgetOptions() {
        AiAnalysisService service = new AiAnalysisService(RestClient.create(), new ObjectMapper(),
            mock(AnalysisCacheRepository.class), mock(ResumeProfileRepository.class));
        ReflectionTestUtils.setField(service, "model", "gemini-3.5-flash-lite");

        var generation = service.generationConfig(service.overviewSchema(), 700, true, true, true);

        assertEquals("application/json", generation.get("responseMimeType"));
        assertFalse(generation.containsKey("temperature"));
        assertFalse(generation.containsKey("thinkingConfig"));
        assertTrue(generation.containsKey("responseSchema"));
    }

    private void assertNoForbiddenKeysOrUnionTypes(JsonNode node) {
        if (node.isObject()) {
            node.fieldNames().forEachRemaining(name -> assertFalse(Set.of("additionalProperties", "$schema", "$ref", "oneOf", "anyOf", "allOf").contains(name), "Forbidden schema key: " + name));
            node.fields().forEachRemaining(entry -> assertNoForbiddenKeysOrUnionTypes(entry.getValue()));
            if (node.has("type")) assertFalse(node.get("type").isArray(), "Union types are not allowed");
        } else if (node.isArray()) {
            node.forEach(this::assertNoForbiddenKeysOrUnionTypes);
        }
    }
}
