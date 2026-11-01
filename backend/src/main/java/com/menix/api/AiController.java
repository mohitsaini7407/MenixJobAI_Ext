package com.menix.api;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.*; import org.springframework.web.bind.annotation.*; import org.springframework.web.client.RestClient;
import java.util.*;
@RestController @RequestMapping("/api/ai")
public class AiController {
 @Value("${menix.gemini.api-key:}") private String apiKey;
 @Value("${menix.gemini.model:gemini-2.5-flash}") private String model;
 public record TailorRequest(String resumeText,String jobDescription){}
 @PostMapping("/tailor-review") public Map<String,Object> tailor(@RequestBody TailorRequest req) {
  if(apiKey==null||apiKey.isBlank()) return Map.of("error","Gemini API key is not configured on the backend. Set GEMINI_API_KEY and restart.");
  if(req.resumeText()==null||req.resumeText().isBlank()||req.jobDescription()==null||req.jobDescription().isBlank()) throw new IllegalArgumentException("Resume text and job description are required.");
  String prompt = """
   Compare the candidate resume with the job description. Be conservative and truthful:
   never claim a skill, employer, date, achievement, metric, qualification, or experience
   that is not supported by the resume. Scores are estimates based only on the supplied
   text, not hiring predictions. Do not treat a skill as matched unless the resume supports it.

   Return exactly one JSON object with these keys and types:
   {
     "matchSummary": "short explanation",
     "matchScore": integer 0-100,
     "matchLevel": "Strong Match" | "Good Match" | "Partial Match" | "Low Match",
     "skillsMatchScore": integer 0-100 or null,
     "experienceMatchScore": integer 0-100 or null,
     "keywordMatchScore": integer 0-100 or null,
     "matchedSkills": ["specific required skill supported by resume"],
     "missingSkills": ["specific explicit job requirement not evidenced in resume"],
     "supportedKeywords": ["job keyword supported by resume"],
     "gapsToVerify": ["requirement that is missing or unclear"],
     "suggestedSummary": "truthful optional summary",
     "rewrittenBullets": ["truthful optional bullet"],
     "cautions": ["claim that the candidate should verify"]
   }

   Scoring rules:
   - skillsMatchScore: supported distinct required skills divided by distinct required skills.
   - keywordMatchScore: supported explicit job keywords divided by explicit required keywords.
   - experienceMatchScore: compare only stated experience requirements with dated/role evidence;
     return null if the job gives no experience requirement or the resume lacks enough evidence.
   - matchScore: weighted average of available component scores (skills 40%, experience 30%,
     keywords 30%), renormalized over non-null components. Return null if no component can be
     evaluated. Set matchLevel from matchScore: Strong 80-100, Good 65-79, Partial 40-64,
     Low 0-39; use "Not scored" when matchScore is null.
   - Return empty arrays when there are no items. Never invent missing skills; list only
     explicit requirements from the job description that the resume does not demonstrate.
   - Return JSON only. Use null, not a guessed number, when a component cannot be assessed.

   CANDIDATE RESUME:
   %s

   JOB DESCRIPTION:
   %s
   """.formatted(req.resumeText(), req.jobDescription());
  String url="https://generativelanguage.googleapis.com/v1beta/models/"+model+":generateContent?key="+apiKey;
  Map<String,Object> body=Map.of(
   "contents",List.of(Map.of("parts",List.of(Map.of("text",prompt)))),
   "generationConfig",Map.of("responseMimeType","application/json")
  );
  Map result=RestClient.create().post().uri(url).contentType(MediaType.APPLICATION_JSON).body(body).retrieve().body(Map.class);
  return Map.of("model",model,"review",result==null?Map.of():result,"notice","AI suggestions only. Verify every statement and approve edits before using them.");
 }
}
