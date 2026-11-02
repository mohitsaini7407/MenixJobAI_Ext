package com.menix.model;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.LocalDateTime;

@Entity
@Table(name = "resume_profile")
public class ResumeProfile {
    @Id
    @Column(length = 64, nullable = false)
    private String resumeHash;
    @Column(columnDefinition = "text", nullable = false)
    private String profileJson;
    @Column(nullable = false)
    private LocalDateTime updatedAt = LocalDateTime.now();

    public ResumeProfile() {}
    public ResumeProfile(String resumeHash, String profileJson) {
        this.resumeHash = resumeHash;
        this.profileJson = profileJson;
        this.updatedAt = LocalDateTime.now();
    }
    public String getResumeHash() { return resumeHash; }
    public String getProfileJson() { return profileJson; }
    public LocalDateTime getUpdatedAt() { return updatedAt; }
}
