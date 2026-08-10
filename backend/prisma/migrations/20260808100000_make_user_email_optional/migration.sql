-- Email is an optional secondary sign-in identifier. MySQL unique indexes
-- permit multiple NULL values, while continuing to reject duplicate emails.
ALTER TABLE `User`
  MODIFY `email` VARCHAR(191) NULL;
