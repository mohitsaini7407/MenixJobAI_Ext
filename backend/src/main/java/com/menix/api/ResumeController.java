package com.menix.api;
import org.springframework.beans.factory.annotation.Value; import org.springframework.http.*;
import org.springframework.web.bind.annotation.*; import org.springframework.web.multipart.MultipartFile;
import java.nio.file.*; import java.util.*;
@RestController @RequestMapping("/api/resumes")
public class ResumeController {
 @Value("${menix.upload-dir:uploads}") private String uploadDir;
 @PostMapping("/upload") public Map<String,Object> upload(@RequestParam("file") MultipartFile file) throws Exception {
  if(file.isEmpty()) throw new IllegalArgumentException("Select a file");
  String name=Objects.requireNonNullElse(file.getOriginalFilename(),"resume").replaceAll("[^a-zA-Z0-9._-]","_");
  String ext=name.toLowerCase(); if(!(ext.endsWith(".pdf")||ext.endsWith(".docx"))) throw new IllegalArgumentException("Only PDF and DOCX files are supported");
  Path dir=Paths.get(uploadDir).toAbsolutePath().normalize(); Files.createDirectories(dir);
  String stored=UUID.randomUUID()+"-"+name; Path dest=dir.resolve(stored).normalize();
  if(!dest.startsWith(dir)) throw new IllegalArgumentException("Invalid filename");
  Files.copy(file.getInputStream(),dest,StandardCopyOption.REPLACE_EXISTING);
  return Map.of("storedName",stored,"originalName",name,"size",file.getSize(),"message","Resume stored locally");
 }
}
