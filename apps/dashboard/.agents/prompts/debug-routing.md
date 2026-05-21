# Debug Routing

Identify a message with `direction = 'unknown'` and trace its `from_phone_number` and `to_phone_number` against the `VITE_TEXTGRID_FROM_NUMBER`. 
Determine if the webhook source app is correctly configured.
Check if the message should have been classified as `inbound` based on the owner's phone number matching.
