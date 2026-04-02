type EsewaInitResponse = {
  formAction: string;
  fields: Record<string, string>;
};

export function submitEsewaForm(payload: EsewaInitResponse) {
  if (typeof document === "undefined") {
    throw new Error("eSewa redirect is only available in the browser.");
  }

  const form = document.createElement("form");
  form.method = "POST";
  form.action = payload.formAction;
  form.style.display = "none";

  Object.entries(payload.fields || {}).forEach(([key, value]) => {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = key;
    input.value = String(value ?? "");
    form.appendChild(input);
  });

  document.body.appendChild(form);
  form.submit();
}
