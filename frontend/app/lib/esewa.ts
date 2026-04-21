// the response shape we get back from initiateEsewaPaymentApi
type EsewaInitResponse = {
  formAction: string; // the URL to POST the form to (eSewa's payment gateway)
  fields: Record<string, string>; // the signed form fields to include in the POST
};

// creating a hidden HTML form and submitting it to eSewa's payment gateway
// we do this instead of a normal API call because eSewa requires a browser redirect
// through a form POST — the user gets taken to eSewa's website to complete the payment
export function submitEsewaForm(payload: EsewaInitResponse) {
  if (typeof document === "undefined") {
    throw new Error("eSewa redirect is only available in the browser.");
  }

  // creating the form element programmatically
  const form = document.createElement("form");
  form.method = "POST";
  form.action = payload.formAction;
  form.style.display = "none"; // hiding the form since we are auto-submitting it

  // adding each signed field as a hidden input
  Object.entries(payload.fields || {}).forEach(([key, value]) => {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = key;
    input.value = String(value ?? "");
    form.appendChild(input);
  });

  // appending the form to the page and submitting it — this redirects the user to eSewa
  document.body.appendChild(form);
  form.submit();
}
