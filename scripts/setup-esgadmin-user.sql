-- Creates (or fixes) the ESGAdmin MySQL account with every privilege the app
-- needs, including CREATE — without it, self-healing schema checks like
-- ensureAssistantQuestionsTable() in app.js fail with:
--   #1142 - CREATE command denied to user 'ESGAdmin'@'localhost'
-- Safe to re-run on any laptop, new or existing: CREATE USER IF NOT EXISTS
-- and GRANT are both idempotent.
--
-- Run this once via phpMyAdmin's SQL tab, or:
--   C:\xampp\mysql\bin\mysql.exe -u root < scripts\setup-esgadmin-user.sql

CREATE USER IF NOT EXISTS 'ESGAdmin'@'localhost' IDENTIFIED BY '12345678';

GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, DROP
  ON esgdashboard.*
  TO 'ESGAdmin'@'localhost';

FLUSH PRIVILEGES;
