# Prompt: Tune Message Classifier

Act as a Data Scientist specializing in NLP and Regex. I need to update the inbox priority classifier with new intent patterns.

## Current Patterns:
- **Hot**: Price inquiries, callback requests.
- **Warm**: General interest, occupancy questions.

## Task:
1. Analyze the sample messages provided.
2. Generate highly specific POSIX regex patterns for the following new categories:
   - **FollowUp**: "Still available?", "Check back in"
   - **Objection**: "Too low", "Not for sale"
3. Ensure patterns avoid false positives with existing **DNC** filters.

## Output:
Provide the SQL `CASE` statement fragments and a set of test strings to verify the patterns.
