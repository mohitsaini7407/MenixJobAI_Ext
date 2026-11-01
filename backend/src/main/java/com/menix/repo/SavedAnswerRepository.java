package com.menix.repo;
import com.menix.model.SavedAnswer; import org.springframework.data.jpa.repository.JpaRepository;
public interface SavedAnswerRepository extends JpaRepository<SavedAnswer,Long> {}
