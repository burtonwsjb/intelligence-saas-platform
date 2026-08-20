-- Phase 18: tenant webhook delete/rotate support for the customer application.

DROP POLICY IF EXISTS webhook_endpoint_delete ON "webhook_endpoint";
CREATE POLICY webhook_endpoint_delete ON "webhook_endpoint"
  FOR DELETE
  USING (
    "organization_id" = app.current_organization_id()
    AND app.is_authorized_principal()
  );

DROP POLICY IF EXISTS webhook_delivery_delete ON "webhook_delivery";
CREATE POLICY webhook_delivery_delete ON "webhook_delivery"
  FOR DELETE
  USING (
    "organization_id" = app.current_organization_id()
    AND app.is_authorized_principal()
  );
