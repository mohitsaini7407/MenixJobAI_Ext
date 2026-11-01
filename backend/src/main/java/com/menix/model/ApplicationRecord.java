package com.menix.model;
import jakarta.persistence.*;
import java.time.LocalDateTime;
@Entity @Table(name="applications")
public class ApplicationRecord {
 @Id @GeneratedValue(strategy=GenerationType.IDENTITY) private Long id;
 private String company; private String jobTitle; private String status="PLANNED";
 private LocalDateTime appliedAt; @Column(length=4000) private String notes;
 public Long getId(){return id;} public void setId(Long v){id=v;}
 public String getCompany(){return company;} public void setCompany(String v){company=v;}
 public String getJobTitle(){return jobTitle;} public void setJobTitle(String v){jobTitle=v;}
 public String getStatus(){return status;} public void setStatus(String v){status=v;}
 public LocalDateTime getAppliedAt(){return appliedAt;} public void setAppliedAt(LocalDateTime v){appliedAt=v;}
 public String getNotes(){return notes;} public void setNotes(String v){notes=v;}
}
