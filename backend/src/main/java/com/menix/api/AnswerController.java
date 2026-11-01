package com.menix.api;
import com.menix.model.SavedAnswer; import com.menix.repo.SavedAnswerRepository;
import org.springframework.web.bind.annotation.*; import java.util.List;
@RestController @RequestMapping("/api/answers")
public class AnswerController {
 private final SavedAnswerRepository repo; public AnswerController(SavedAnswerRepository r){repo=r;}
 @GetMapping public List<SavedAnswer> all(){return repo.findAll();}
 @PostMapping public SavedAnswer create(@RequestBody SavedAnswer a){a.setUpdatedAt(java.time.LocalDateTime.now());return repo.save(a);}
 @PutMapping("/{id}") public SavedAnswer update(@PathVariable Long id,@RequestBody SavedAnswer a){a.setId(id);a.setUpdatedAt(java.time.LocalDateTime.now());return repo.save(a);}
 @DeleteMapping("/{id}") public void delete(@PathVariable Long id){repo.deleteById(id);}
}
