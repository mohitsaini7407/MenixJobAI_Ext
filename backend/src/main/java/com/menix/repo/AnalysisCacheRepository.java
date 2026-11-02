package com.menix.repo;

import com.menix.model.AnalysisCache;
import java.time.LocalDateTime;
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;

public interface AnalysisCacheRepository extends JpaRepository<AnalysisCache, String> {
    Optional<AnalysisCache> findByCacheKeyAndKind(String cacheKey, String kind);
    void deleteByCreatedAtBefore(LocalDateTime cutoff);
}
