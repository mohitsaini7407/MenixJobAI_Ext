package com.menix.config;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.stereotype.Component;

import java.util.Set;

@Component
public class GeminiModelStartupValidator implements ApplicationRunner {
    private static final Set<String> SUPPORTED_MODELS = Set.of(
        "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-pro");

    @Value("${menix.gemini.model:gemini-2.5-flash}")
    private String model;

    @Override
    public void run(ApplicationArguments args) {
        if (!SUPPORTED_MODELS.contains(model)) {
            throw new IllegalStateException("Unsupported GEMINI_MODEL '" + model + "'. Supported models: " + String.join(", ", SUPPORTED_MODELS));
        }
    }
}
