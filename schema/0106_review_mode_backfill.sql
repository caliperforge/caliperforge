UPDATE runs SET mode = 'review' WHERE seat IN ('code_quality', 'senior_review') AND staffed IS NOT NULL AND mode IS NULL;
