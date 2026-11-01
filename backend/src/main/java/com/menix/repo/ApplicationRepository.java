package com.menix.repo;
import com.menix.model.ApplicationRecord; import org.springframework.data.jpa.repository.JpaRepository;
public interface ApplicationRepository extends JpaRepository<ApplicationRecord,Long> {}
