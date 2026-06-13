package com.example.posture.constant;

public enum QualityLevel {
    EXCELLENT("优秀", 88),
    GOOD("良好", 75),
    MID("一般", 60),
    FAIL("不合格", 0);

    private final String label;
    private final int minScore;

    QualityLevel(String label, int minScore) {
        this.label = label;
        this.minScore = minScore;
    }

    public String getLabel() {
        return label;
    }

    public static String fromScore(double score) {
        if (score >= 88) return EXCELLENT.label;
        if (score >= 75) return GOOD.label;
        if (score >= 60) return MID.label;
        return FAIL.label;
    }

    public static boolean isValid(String label) {
        for (QualityLevel q : values()) {
            if (q.label.equals(label)) return true;
        }
        return false;
    }
}
