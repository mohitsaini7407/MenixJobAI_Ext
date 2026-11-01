package com.menix.model;
import jakarta.persistence.*;
import java.time.LocalDateTime;
@Entity @Table(name="saved_answers")
public class SavedAnswer {
 @Id @GeneratedValue(strategy=GenerationType.IDENTITY) private Long id;
 @Column(length=2000) private String question;
 @Column(length=5000) private String answer;
 private boolean approved=false; private LocalDateTime updatedAt=LocalDateTime.now();
 public Long getId(){return id;} public void setId(Long v){id=v;}
 public String getQuestion(){return question;} public void setQuestion(String v){question=v;}
 public String getAnswer(){return answer;} public void setAnswer(String v){answer=v;}
 public boolean isApproved(){return approved;} public void setApproved(boolean v){approved=v;}
 public LocalDateTime getUpdatedAt(){return updatedAt;} public void setUpdatedAt(LocalDateTime v){updatedAt=v;}
}
