package com.menix.api;
import com.menix.model.Job; import com.menix.repo.JobRepository;
import org.springframework.web.bind.annotation.*; import org.springframework.http.HttpStatus; import org.springframework.web.server.ResponseStatusException;
import java.util.List;
@RestController @RequestMapping("/api/jobs")
public class JobController {
 private final JobRepository repo; public JobController(JobRepository r){repo=r;}
 @GetMapping public List<Job> all(){return repo.findAll();}
 @PostMapping public Job create(@RequestBody Job job){if(job.getTitle()==null||job.getTitle().isBlank()) throw new ResponseStatusException(HttpStatus.BAD_REQUEST,"Job title is required"); return repo.save(job);}
 @PutMapping("/{id}") public Job update(@PathVariable Long id,@RequestBody Job input){Job j=repo.findById(id).orElseThrow(()->new ResponseStatusException(HttpStatus.NOT_FOUND)); j.setTitle(input.getTitle());j.setCompany(input.getCompany());j.setLocation(input.getLocation());j.setWorkMode(input.getWorkMode());j.setExperience(input.getExperience());j.setSource(input.getSource());j.setDescription(input.getDescription());j.setOriginalUrl(input.getOriginalUrl());j.setApplicationUrl(input.getApplicationUrl());j.setStatus(input.getStatus());return repo.save(j);}
 @DeleteMapping("/{id}") public void delete(@PathVariable Long id){repo.deleteById(id);}
}
