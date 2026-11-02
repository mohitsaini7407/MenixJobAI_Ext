package com.menix.repo;

import com.menix.model.ResumeProfile;
import org.springframework.data.jpa.repository.JpaRepository;

public interface ResumeProfileRepository extends JpaRepository<ResumeProfile, String> {}
