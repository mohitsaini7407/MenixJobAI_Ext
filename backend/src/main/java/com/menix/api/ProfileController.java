package com.menix.api;
import org.springframework.web.bind.annotation.*; import java.util.concurrent.atomic.AtomicReference; import java.util.Map;
@RestController @RequestMapping("/api/profile")
public class ProfileController {
 private static final AtomicReference<Map<String,Object>> PROFILE=new AtomicReference<>(Map.of());
 @GetMapping public Map<String,Object> get(){return PROFILE.get();}
 @PutMapping public Map<String,Object> save(@RequestBody Map<String,Object> p){PROFILE.set(Map.copyOf(p));return PROFILE.get();}
}
