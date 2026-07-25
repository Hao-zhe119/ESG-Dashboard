CREATE TABLE IF NOT EXISTS assistant_questions (
  id int(11) NOT NULL AUTO_INCREMENT,
  account_id int(11) NOT NULL,
  question text NOT NULL,
  asked_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY account_id (account_id),
  KEY asked_at (asked_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
