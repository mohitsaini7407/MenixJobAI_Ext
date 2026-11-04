package com.menix.model;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import java.util.List;

@JsonIgnoreProperties(ignoreUnknown = true)
public record DocxTailoringReport(
    List<AppliedEdit> applied,
    List<SkippedEdit> skipped,
    boolean textChanged,
    int pageCountBefore,
    int pageCountAfter,
    boolean fontsUnchanged,
    boolean marginsUnchanged,
    String summary
) {
    public DocxTailoringReport {
        applied = applied == null ? List.of() : List.copyOf(applied);
        skipped = skipped == null ? List.of() : List.copyOf(skipped);
    }

    public record AppliedEdit(
        String editId,
        String paragraphId,
        String op,
        String before,
        String after,
        String reason
    ) {}

    public record SkippedEdit(
        String editId,
        String reason
    ) {}
}

