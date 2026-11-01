package com.menix.model;
import jakarta.persistence.*;
import java.time.LocalDateTime;
@Entity @Table(name="jobs")
public class Job {
 @Id @GeneratedValue(strategy=GenerationType.IDENTITY) private Long id;
 private String title; private String company; private String location;
 private String workMode; private String experience; private String source;
 @Column(length=12000) private String description;
 private String originalUrl; private String applicationUrl;
 private String status="SAVED"; private LocalDateTime createdAt=LocalDateTime.now();
 public Long getId(){return id;} public void setId(Long v){id=v;}
 public String getTitle(){return title;} public void setTitle(String v){title=v;}
 public String getCompany(){return company;} public void setCompany(String v){company=v;}
 public String getLocation(){return location;} public void setLocation(String v){location=v;}
 public String getWorkMode(){return workMode;} public void setWorkMode(String v){workMode=v;}
 public String getExperience(){return experience;} public void setExperience(String v){experience=v;}
 public String getSource(){return source;} public void setSource(String v){source=v;}
 public String getDescription(){return description;} public void setDescription(String v){description=v;}
 public String getOriginalUrl(){return originalUrl;} public void setOriginalUrl(String v){originalUrl=v;}
 public String getApplicationUrl(){return applicationUrl;} public void setApplicationUrl(String v){applicationUrl=v;}
 public String getStatus(){return status;} public void setStatus(String v){status=v;}
 public LocalDateTime getCreatedAt(){return createdAt;}
}
