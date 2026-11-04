package com.menix.service;

import com.menix.model.JobSpec;
import com.menix.model.MatchAnalysisResult;
import com.menix.model.MatchAnalysisResult.RequirementItem;
import com.menix.model.RoleFamily;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

public final class JobSpecMatcherService {

    private static final Map<String, String> ALIASES = initAliases();

    public static MatchAnalysisResult evaluate(JobSpec job, String resumeText) {
        String normalizedResume = normalize(resumeText);
        RoleFamily resumeFamily = classifyResumeFamily(normalizedResume);
        RoleFamily jobFamily = job.roleFamily() != null 
            ? RoleFamily.parse(job.roleFamily()) 
            : classifyJobFamily(job.title() + " " + String.join(" ", job.keySkillTags()));
        RoleFamily.Fit fit = RoleFamily.calculateFit(resumeFamily, jobFamily);

        List<RequirementItem> requirements = new ArrayList<>();
        List<String> matchedSkills = new ArrayList<>();
        List<String> missingSkills = new ArrayList<>();
        Set<String> seenNormalizedReqs = new LinkedHashSet<>();

        double earnedSkills = 0;
        double totalSkillsPossible = 0;

        // Process Must-Haves (weight = 2.0)
        int idCounter = 1;
        for (String req : job.mustHave()) {
            if (req == null || req.isBlank()) continue;
            String canon = canonical(req);
            if (!seenNormalizedReqs.add(canon)) continue;

            boolean exact = containsTerm(normalizedResume, req);
            boolean equiv = !exact && equivalentPresent(normalizedResume, req);
            String evidence = exact ? findLiteralEvidence(resumeText, req) : (equiv ? findAliasEvidence(req, resumeText) : "");
            String status = exact ? "matched" : (equiv ? "equivalent" : "missing");
            String confidence = (exact || equiv) ? "high" : "low";

            if (exact || equiv) {
                matchedSkills.add(req);
                earnedSkills += (exact ? 2.0 : 1.8);
            } else {
                missingSkills.add(req);
            }
            totalSkillsPossible += 2.0;

            requirements.add(new RequirementItem("req-" + (idCounter++), req, "must", status, evidence, confidence));
        }

        // Process Nice-To-Haves (weight = 1.0)
        for (String req : job.niceToHave()) {
            if (req == null || req.isBlank()) continue;
            String canon = canonical(req);
            if (!seenNormalizedReqs.add(canon)) continue;

            boolean exact = containsTerm(normalizedResume, req);
            boolean equiv = !exact && equivalentPresent(normalizedResume, req);
            String evidence = exact ? findLiteralEvidence(resumeText, req) : (equiv ? findAliasEvidence(req, resumeText) : "");
            String status = exact ? "matched" : (equiv ? "equivalent" : "missing");
            String confidence = (exact || equiv) ? "high" : "low";

            if (exact || equiv) {
                matchedSkills.add(req);
                earnedSkills += (exact ? 1.0 : 0.9);
            } else {
                missingSkills.add(req);
            }
            totalSkillsPossible += 1.0;

            requirements.add(new RequirementItem("req-" + (idCounter++), req, "nice", status, evidence, confidence));
        }

        // Skills Score
        int skillsScore = totalSkillsPossible > 0 
            ? (int) Math.round(100.0 * earnedSkills / totalSkillsPossible) 
            : 0;

        // Keywords Score (based on keySkillTags and tools)
        List<String> allKeywords = new ArrayList<>(job.keySkillTags());
        for (String tool : job.tools()) {
            if (!allKeywords.contains(tool)) allKeywords.add(tool);
        }
        int matchedKeywords = 0;
        int totalKeywords = 0;
        Set<String> seenKeywords = new LinkedHashSet<>();
        for (String kw : allKeywords) {
            String canon = canonical(kw);
            if (!seenKeywords.add(canon)) continue;
            totalKeywords++;
            if (containsTerm(normalizedResume, kw) || equivalentPresent(normalizedResume, kw)) {
                matchedKeywords++;
            }
        }
        int keywordsScore = totalKeywords > 0 
            ? (int) Math.round(100.0 * matchedKeywords / totalKeywords) 
            : skillsScore;

        // Experience Score
        int experienceScore = calculateExperienceScore(normalizedResume, job.yearsMin(), job.yearsMax());

        // Education Score
        int educationScore = calculateEducationScore(normalizedResume, job.education());

        // Unrequested Resume Skills (skills on resume NOT asked by this job)
        List<String> unrequestedResumeSkills = findUnrequestedSkills(normalizedResume, seenNormalizedReqs, seenKeywords);

        // Combined 4-component score: 0.45*skills + 0.25*keywords + 0.20*experience + 0.10*education
        double weightedSum = 0.45 * skillsScore + 0.25 * keywordsScore + 0.20 * experienceScore + 0.10 * educationScore;
        int calculatedTotal = (int) Math.round(weightedSum);

        // Cap score if different role family
        int finalTotalScore = calculatedTotal;
        if (fit == RoleFamily.Fit.DIFFERENT) {
            finalTotalScore = (jobFamily == RoleFamily.NON_IT || resumeFamily == RoleFamily.NON_IT) 
                ? Math.min(15, calculatedTotal) 
                : Math.min(25, calculatedTotal);
        }

        // Verdict & Reasons
        String verdict;
        List<String> verdictReasons = new ArrayList<>();

        if (fit == RoleFamily.Fit.DIFFERENT) {
            verdict = "Skip";
            verdictReasons.add("Different career track (" + formatFamilyName(jobFamily) + " vs your background in " + formatFamilyName(resumeFamily) + ").");
            if (!missingSkills.isEmpty()) {
                verdictReasons.add("Missing required core skills: " + String.join(", ", missingSkills.stream().limit(3).toList()) + ".");
            }
        } else if (finalTotalScore >= 80) {
            verdict = "Strong";
            verdictReasons.add("Strong alignment across core requirements and technical competencies.");
            if (!matchedSkills.isEmpty()) {
                verdictReasons.add("Evidenced key skills: " + String.join(", ", matchedSkills.stream().limit(3).toList()) + ".");
            }
            if (!missingSkills.isEmpty()) {
                verdictReasons.add("Growth gap to address: " + missingSkills.get(0) + ".");
            }
        } else if (finalTotalScore >= 65) {
            verdict = "Good";
            verdictReasons.add("Solid match on primary qualifications with transferable technical overlap.");
            if (!matchedSkills.isEmpty()) {
                verdictReasons.add("Matched: " + String.join(", ", matchedSkills.stream().limit(3).toList()) + ".");
            }
            if (!missingSkills.isEmpty()) {
                verdictReasons.add("Lacks explicit experience in: " + String.join(", ", missingSkills.stream().limit(2).toList()) + ".");
            }
        } else if (finalTotalScore >= 40) {
            verdict = "Stretch";
            verdictReasons.add("Moderate skill crossover, but key prerequisites are missing from your resume.");
            if (!missingSkills.isEmpty()) {
                verdictReasons.add("Missing must-haves: " + String.join(", ", missingSkills.stream().limit(3).toList()) + ".");
            }
            if (!matchedSkills.isEmpty()) {
                verdictReasons.add("Transferable skills: " + String.join(", ", matchedSkills.stream().limit(2).toList()) + ".");
            }
        } else {
            verdict = "Skip";
            verdictReasons.add("Score below 40% with substantial gaps in mandatory requirements.");
            if (!missingSkills.isEmpty()) {
                verdictReasons.add("Missing: " + String.join(", ", missingSkills.stream().limit(3).toList()) + ".");
            }
        }

        // Red Flags
        List<String> redFlags = new ArrayList<>(job.redFlags());
        detectRedFlagsInJob(job, redFlags);

        Map<String, Integer> componentScores = new LinkedHashMap<>();
        componentScores.put("skills", skillsScore);
        componentScores.put("keywords", keywordsScore);
        componentScores.put("experience", experienceScore);
        componentScores.put("education", educationScore);

        String formula = String.format("0.45 * %d (Skills) + 0.25 * %d (Keywords) + 0.20 * %d (Experience) + 0.10 * %d (Education) = %d%s",
            skillsScore, keywordsScore, experienceScore, educationScore, calculatedTotal,
            fit == RoleFamily.Fit.DIFFERENT ? " (Capped at " + finalTotalScore + " due to Different Career Track)" : "");

        return new MatchAnalysisResult(
            finalTotalScore,
            componentScores,
            formula,
            fit,
            jobFamily,
            resumeFamily,
            verdict,
            verdictReasons,
            requirements,
            matchedSkills,
            missingSkills,
            unrequestedResumeSkills,
            redFlags
        );
    }

    private static void detectRedFlagsInJob(JobSpec job, List<String> redFlags) {
        if (job.bondOrAgreement() && redFlags.stream().noneMatch(r -> r.toLowerCase().contains("agreement") || r.toLowerCase().contains("bond"))) {
            redFlags.add("Service agreement / bond required");
        }
        if (job.shift() != null && job.shift().toLowerCase().contains("night") && redFlags.stream().noneMatch(r -> r.toLowerCase().contains("night"))) {
            redFlags.add("Night shift / US hours");
        }
        if (job.employmentType() != null && job.employmentType().toLowerCase().contains("contract") && redFlags.stream().noneMatch(r -> r.toLowerCase().contains("contract"))) {
            redFlags.add("Contractual employment");
        }
    }

    private static int calculateExperienceScore(String normalizedResume, int yearsMin, int yearsMax) {
        if (yearsMin == 0 && yearsMax <= 1) return 100; // Fresher / Trainee role
        // Check graduation / experience indicators
        boolean isFresher = normalizedResume.contains("2026") || normalizedResume.contains("fresher") || normalizedResume.contains("intern");
        if (isFresher && yearsMin <= 1) return 100;
        if (isFresher && yearsMin > 1) return Math.max(30, 100 - (yearsMin * 20));
        return 80;
    }

    private static int calculateEducationScore(String normalizedResume, String expectedEducation) {
        // Candidate has B.Tech Computer Science and Engineering
        boolean hasTechDegree = normalizedResume.contains("b tech") || normalizedResume.contains("bachelor of technology") || normalizedResume.contains("b e ") || normalizedResume.contains("computer science");
        if (hasTechDegree) return 100;
        return 75;
    }

    private static List<String> findUnrequestedSkills(String normalizedResume, Set<String> requestedCanonicals, Set<String> keywordCanonicals) {
        List<String> knownProfileSkills = List.of(
            "react", "node.js", "express", "mongodb", "postgresql", "python", "javascript", "typescript",
            "sql", "tailwind css", "bootstrap", "aws", "docker", "rest apis", "graphql", "git"
        );
        List<String> unrequested = new ArrayList<>();
        for (String skill : knownProfileSkills) {
            String canon = canonical(skill);
            if (!requestedCanonicals.contains(canon) && !keywordCanonicals.contains(canon)) {
                if (containsTerm(normalizedResume, skill) || equivalentPresent(normalizedResume, skill)) {
                    unrequested.add(formatSkillName(skill));
                }
            }
        }
        return unrequested;
    }

    private static String formatSkillName(String skill) {
        return switch (skill.toLowerCase(Locale.ROOT)) {
            case "react" -> "React";
            case "node.js" -> "Node.js";
            case "express" -> "Express.js";
            case "mongodb" -> "MongoDB";
            case "postgresql" -> "PostgreSQL";
            case "python" -> "Python";
            case "javascript" -> "JavaScript";
            case "typescript" -> "TypeScript";
            case "sql" -> "SQL";
            case "tailwind css" -> "Tailwind CSS";
            case "bootstrap" -> "Bootstrap";
            case "aws" -> "AWS";
            case "docker" -> "Docker";
            case "rest apis" -> "REST APIs";
            case "graphql" -> "GraphQL";
            case "git" -> "Git";
            default -> Character.toUpperCase(skill.charAt(0)) + skill.substring(1);
        };
    }

    private static String formatFamilyName(RoleFamily family) {
        return switch (family) {
            case FULL_STACK_WEB -> "Full Stack Web Development";
            case BACKEND_JAVA -> "Backend Java Engineering";
            case FRONTEND -> "Frontend Engineering";
            case DATA_AI_ML -> "Data Science & AI / ML";
            case DEVOPS_CLOUD -> "DevOps & Cloud Engineering";
            case QA_AUTOMATION -> "QA & Test Automation";
            case PHP_LAMP -> "PHP / LAMP Development";
            case ECOMMERCE_PLATFORM -> "E-Commerce & Shopify Platform";
            case NON_IT -> "Non-IT & Recruitment";
            case OTHER -> "General Software";
        };
    }

    public static RoleFamily classifyResumeFamily(String normalizedResume) {
        if (normalizedResume.contains("react") && (normalizedResume.contains("node") || normalizedResume.contains("mern") || normalizedResume.contains("express"))) {
            return RoleFamily.FULL_STACK_WEB;
        }
        if (normalizedResume.contains("spring") && normalizedResume.contains("java")) {
            return RoleFamily.BACKEND_JAVA;
        }
        if (normalizedResume.contains("react") || normalizedResume.contains("angular") || normalizedResume.contains("vue")) {
            return RoleFamily.FRONTEND;
        }
        if (normalizedResume.contains("python") && (normalizedResume.contains("ai") || normalizedResume.contains("ml") || normalizedResume.contains("tensorflow"))) {
            return RoleFamily.DATA_AI_ML;
        }
        return RoleFamily.FULL_STACK_WEB;
    }

    public static RoleFamily classifyJobFamily(String text) {
        String norm = normalize(text);
        if (norm.contains("recruiter") || norm.contains("talent acquisition") || norm.contains("staffing") || norm.contains("bpo") || norm.contains("cold calling")) {
            return RoleFamily.NON_IT;
        }
        if (norm.contains("shopify") || norm.contains("liquid") || norm.contains("wordpress") || norm.contains("woocommerce") || norm.contains("magento")) {
            return RoleFamily.ECOMMERCE_PLATFORM;
        }
        if (norm.contains("laravel") || norm.contains("php") || norm.contains("codeigniter") || norm.contains("lamp")) {
            return RoleFamily.PHP_LAMP;
        }
        if (norm.contains("spring") || norm.contains("java developer") || norm.contains("backend java") || norm.contains("hibernate")) {
            return RoleFamily.BACKEND_JAVA;
        }
        if (norm.contains("devops") || norm.contains("kubernetes") || norm.contains("k8s") || norm.contains("terraform") || norm.contains("ci cd") || norm.contains("ansible")) {
            return RoleFamily.DEVOPS_CLOUD;
        }
        if (norm.contains("qa") || norm.contains("selenium") || norm.contains("automation test") || norm.contains("cypress") || norm.contains("sdet")) {
            return RoleFamily.QA_AUTOMATION;
        }
        if (norm.contains("frontend") || norm.contains("react developer") || norm.contains("angular developer") || norm.contains("ui developer")) {
            return RoleFamily.FRONTEND;
        }
        if (norm.contains("data scientist") || norm.contains("machine learning") || norm.contains("ai engineer") || norm.contains("deep learning")) {
            return RoleFamily.DATA_AI_ML;
        }
        return RoleFamily.FULL_STACK_WEB;
    }

    private static boolean containsTerm(String normalizedSource, String term) {
        String normalizedTerm = normalize(term);
        if (normalizedTerm.isBlank()) return false;
        String haystack = " " + normalizedSource + " ";
        return haystack.contains(" " + normalizedTerm + " ");
    }

    private static boolean equivalentPresent(String normalizedResume, String requirement) {
        String canonical = canonical(requirement);
        for (Map.Entry<String, String> alias : ALIASES.entrySet()) {
            if (alias.getValue().equals(canonical) && !alias.getKey().equals(normalize(requirement))) {
                if (containsTerm(normalizedResume, alias.getKey())) return true;
            }
        }
        return false;
    }

    private static String findAliasEvidence(String requirement, String resumeText) {
        String canonical = canonical(requirement);
        for (Map.Entry<String, String> entry : ALIASES.entrySet()) {
            if (entry.getValue().equals(canonical) && containsTerm(normalize(resumeText), entry.getKey())) {
                return findLiteralEvidence(resumeText, entry.getKey());
            }
        }
        return "";
    }

    private static String findLiteralEvidence(String source, String term) {
        if (source == null || term == null) return "";
        int at = source.toLowerCase(Locale.ROOT).indexOf(term.toLowerCase(Locale.ROOT));
        if (at < 0) return term;
        int start = Math.max(0, source.lastIndexOf('\n', at) + 1);
        int end = source.indexOf('\n', at);
        if (end < 0) end = source.length();
        String line = source.substring(start, end).trim();
        return line.length() > 100 ? line.substring(0, 97) + "…" : line;
    }

    private static String canonical(String value) {
        String normalized = normalize(value);
        return ALIASES.getOrDefault(normalized, normalized);
    }

    private static String normalize(String value) {
        return value == null ? "" : value.toLowerCase(Locale.ROOT)
            .replaceAll("[^\\p{L}\\p{N}+#.]+", " ")
            .replaceAll("\\s+", " ")
            .trim();
    }

    private static Map<String, String> initAliases() {
        Map<String, String> map = new LinkedHashMap<>();
        add(map, "react", "react", "reactjs", "react.js");
        add(map, "node", "node", "nodejs", "node.js");
        add(map, "javascript", "javascript", "js", "ecmascript");
        add(map, "typescript", "typescript", "ts");
        add(map, "tdd", "tdd", "test driven development", "test-driven development");
        add(map, "postgres", "postgres", "postgresql");
        add(map, "k8s", "k8s", "kubernetes");
        add(map, "aws", "aws", "amazon web services");
        add(map, "gcp", "gcp", "google cloud platform");
        add(map, "azure", "azure", "microsoft azure");
        add(map, "dsa", "dsa", "data structures", "algorithms", "data structures and algorithms", "data structures & algorithms");
        add(map, "oop", "oop", "oops", "object oriented programming", "object-oriented programming");
        add(map, "rest", "rest", "rest api", "rest apis", "restful", "restful api", "restful apis");
        add(map, "graphql", "graphql", "graphql api", "graphql apis");
        add(map, "html", "html", "html5");
        add(map, "css", "css", "css3");
        add(map, "tailwind", "tailwind", "tailwind css", "tailwindcss");
        add(map, "bootstrap", "bootstrap", "bootstrap 5", "bootstrap 4");
        add(map, "php", "php", "php8", "php7");
        add(map, "laravel", "laravel", "laravel framework");
        add(map, "mysql", "mysql", "my sql");
        add(map, "mongodb", "mongodb", "mongo", "mongo db");
        add(map, "mern", "mern", "mern stack");
        add(map, "liquid", "liquid", "shopify liquid");
        add(map, "ci cd", "ci cd", "ci/cd", "continuous integration", "continuous deployment");
        return Map.copyOf(map);
    }

    private static void add(Map<String, String> map, String canonical, String... variants) {
        String normCanon = normalize(canonical);
        for (String v : variants) {
            map.put(normalize(v), normCanon);
        }
    }
}
