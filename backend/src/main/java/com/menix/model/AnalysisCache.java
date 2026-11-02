package com.menix.model;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.LocalDateTime;

@Entity
@Table(name = "analysis_cache")
public class AnalysisCache {
    @Id
    @Column(length = 64, nullable = false)
    private String cacheKey;
    @Column(length = 24, nullable = false)
    private String kind;
    @Column(columnDefinition = "text", nullable = false)
    private String json;
    @Column(nullable = false)
    private LocalDateTime createdAt = LocalDateTime.now();

    public AnalysisCache() {}
    public AnalysisCache(String cacheKey, String kind, String json) {
        this.cacheKey = cacheKey;
        this.kind = kind;
        this.json = json;
        this.createdAt = LocalDateTime.now();
    }
    public String getCacheKey() { return cacheKey; }
    public String getKind() { return kind; }
    public String getJson() { return json; }
    public LocalDateTime getCreatedAt() { return createdAt; }
}
