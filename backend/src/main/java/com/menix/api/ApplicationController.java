package com.menix.api;
import com.menix.model.ApplicationRecord; import com.menix.repo.ApplicationRepository;
import org.springframework.web.bind.annotation.*; import java.util.List;
@RestController @RequestMapping("/api/applications")
public class ApplicationController {
 private final ApplicationRepository repo; public ApplicationController(ApplicationRepository r){repo=r;}
 @GetMapping public List<ApplicationRecord> all(){return repo.findAll();}
 @PostMapping public ApplicationRecord create(@RequestBody ApplicationRecord a){return repo.save(a);}
 @PutMapping("/{id}") public ApplicationRecord update(@PathVariable Long id,@RequestBody ApplicationRecord a){a.setId(id);return repo.save(a);}
 @DeleteMapping("/{id}") public void delete(@PathVariable Long id){repo.deleteById(id);}
}
