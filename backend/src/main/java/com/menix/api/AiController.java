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
  String prompt="Act as a truthful resume editor. Compare the candidate resume with the job description. Never invent skills, employers, dates, metrics, qualifications or experience. Return concise JSON with keys: matchSummary, supportedKeywords, gapsToVerify, suggestedSummary, rewrittenBullets, cautions. Mark unsupported requirements as gaps. Candidate resume:\n"+req.resumeText()+"\nJOB DESCRIPTION:\n"+req.jobDescription();
  String url="https://generativelanguage.googleapis.com/v1beta/models/"+model+":generateContent?key="+apiKey;
  Map<String,Object> body=Map.of("contents",List.of(Map.of("parts",List.of(Map.of("text",prompt)))));
  Map result=RestClient.create().post().uri(url).contentType(MediaType.APPLICATION_JSON).body(body).retrieve().body(Map.class);
  return Map.of("model",model,"review",result==null?Map.of():result,"notice","AI suggestions only. Verify every statement and approve edits before using them.");
 }
}
