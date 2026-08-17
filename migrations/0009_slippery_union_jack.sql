-- Custom SQL migration file, put your code below! --
ALTER SEQUENCE "email_profiles_id_seq" RENAME TO "email_account_id_seq";
ALTER SEQUENCE "scrape_profiles_id_seq" RENAME TO "target_audience_id_seq";