package com.menix.model;

import java.util.Locale;

public enum RoleFamily {
    FULL_STACK_WEB,
    BACKEND_JAVA,
    FRONTEND,
    DATA_AI_ML,
    DEVOPS_CLOUD,
    QA_AUTOMATION,
    PHP_LAMP,
    ECOMMERCE_PLATFORM,
    NON_IT,
    OTHER;

    public enum Fit {
        SAME,
        ADJACENT,
        DIFFERENT
    }

    public static RoleFamily parse(String value) {
        if (value == null || value.isBlank()) return OTHER;
        String normalized = value.trim().toUpperCase(Locale.ROOT).replace('-', '_').replace(' ', '_');
        try {
            return RoleFamily.valueOf(normalized);
        } catch (IllegalArgumentException e) {
            if (normalized.contains("PHP") || normalized.contains("LARAVEL") || normalized.contains("LAMP")) return PHP_LAMP;
            if (normalized.contains("SHOPIFY") || normalized.contains("WORDPRESS") || normalized.contains("COMMERCE")) return ECOMMERCE_PLATFORM;
            if (normalized.contains("JAVA") || normalized.contains("SPRING")) return BACKEND_JAVA;
            if (normalized.contains("FRONT") || normalized.contains("REACT") || normalized.contains("ANGULAR")) return FRONTEND;
            if (normalized.contains("FULL") || normalized.contains("MERN") || normalized.contains("WEB")) return FULL_STACK_WEB;
            if (normalized.contains("DATA") || normalized.contains("AI") || normalized.contains("ML") || normalized.contains("PYTHON")) return DATA_AI_ML;
            if (normalized.contains("DEVOPS") || normalized.contains("CLOUD") || normalized.contains("AWS")) return DEVOPS_CLOUD;
            if (normalized.contains("QA") || normalized.contains("TEST") || normalized.contains("AUTOMATION")) return QA_AUTOMATION;
            if (normalized.contains("RECRUIT") || normalized.contains("HR") || normalized.contains("BPO") || normalized.contains("STAFF")) return NON_IT;
            return OTHER;
        }
    }

    public static Fit calculateFit(RoleFamily resumeFamily, RoleFamily jobFamily) {
        if (jobFamily == NON_IT || resumeFamily == NON_IT) {
            return (resumeFamily == jobFamily) ? Fit.SAME : Fit.DIFFERENT;
        }
        if (resumeFamily == jobFamily) return Fit.SAME;

        // Full stack web is adjacent to frontend, backend java, php lamp, and ecommerce
        if (resumeFamily == FULL_STACK_WEB && (jobFamily == FRONTEND || jobFamily == BACKEND_JAVA || jobFamily == PHP_LAMP || jobFamily == ECOMMERCE_PLATFORM || jobFamily == DATA_AI_ML)) {
            return Fit.ADJACENT;
        }
        if (jobFamily == FULL_STACK_WEB && (resumeFamily == FRONTEND || resumeFamily == BACKEND_JAVA || resumeFamily == PHP_LAMP || resumeFamily == ECOMMERCE_PLATFORM || resumeFamily == DATA_AI_ML)) {
            return Fit.ADJACENT;
        }
        // Frontend and Ecommerce are adjacent
        if ((resumeFamily == FRONTEND && jobFamily == ECOMMERCE_PLATFORM) || (resumeFamily == ECOMMERCE_PLATFORM && jobFamily == FRONTEND)) {
            return Fit.ADJACENT;
        }
        // Data/AI and Full Stack with Python are adjacent
        if ((resumeFamily == DATA_AI_ML && jobFamily == FULL_STACK_WEB) || (resumeFamily == FULL_STACK_WEB && jobFamily == DATA_AI_ML)) {
            return Fit.ADJACENT;
        }

        return Fit.DIFFERENT;
    }
}

