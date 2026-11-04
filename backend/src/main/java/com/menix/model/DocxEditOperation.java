package com.menix.model;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import java.util.List;

@JsonIgnoreProperties(ignoreUnknown = true)
public record DocxEditOperation(
    String editId,
    String paragraphId,
    String op, // "replace_span", "replace_paragraph", "reorder_skills", "insert_after", "remove"
    String before,
    String after,
    String reason,
    List<String> requirementIds,
    String risk, // "low", "medium", "high"
    boolean needsConfirm
) {
    public DocxEditOperation {
        requirementIds = requirementIds == null ? List.of() : List.copyOf(requirementIds);
        op = (op == null || op.isBlank()) ? "replace_span" : op.trim().toLowerCase();
        risk = (risk == null || risk.isBlank()) ? "low" : risk.trim().toLowerCase();
    }
}
