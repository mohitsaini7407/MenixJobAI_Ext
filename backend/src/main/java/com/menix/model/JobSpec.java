package com.menix.model;

import java.util.List;

public record JobSpec(
    String id,
    String title,
    String company,
    String roleFamily,
    List<String> mustHave,
    List<String> niceToHave,
    List<String> tools,
    List<String> keySkillTags,
    int yearsMin,
    int yearsMax,
    String education,
    String location,
    String workMode,
    String shift,
    String employmentType,
    boolean bondOrAgreement,
    String salary,
    List<String> responsibilities,
    List<String> redFlags
) {
    public JobSpec {
        mustHave = mustHave == null ? List.of() : List.copyOf(mustHave);
        niceToHave = niceToHave == null ? List.of() : List.copyOf(niceToHave);
        tools = tools == null ? List.of() : List.copyOf(tools);
        keySkillTags = keySkillTags == null ? List.of() : List.copyOf(keySkillTags);
        responsibilities = responsibilities == null ? List.of() : List.copyOf(responsibilities);
        redFlags = redFlags == null ? List.of() : List.copyOf(redFlags);
    }
}
