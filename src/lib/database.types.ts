export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type OrganizationRole =
  | 'owner'
  | 'admin'
  | 'accountant'
  | 'member'
  | 'subcontractor'

export type ProjectStatus = 'active' | 'on_hold' | 'completed' | 'archived'
export type SubcontractorStatus = 'active' | 'inactive' | 'blocked'
export type PayoutOnboardingStatus = 'pending' | 'restricted' | 'ready'
export type PaymentRequestStatus =
  | 'draft'
  | 'submitted'
  | 'approved'
  | 'checkout_created'
  | 'processing'
  | 'paid'
  | 'failed'
  | 'partially_refunded'
  | 'refunded'
  | 'canceled'
export type PaymentStatus =
  | 'pending'
  | 'processing'
  | 'paid'
  | 'failed'
  | 'expired'
  | 'partially_refunded'
  | 'refunded'

export type RefundStatus =
  | 'pending'
  | 'requires_action'
  | 'succeeded'
  | 'failed'
  | 'canceled'

export type WaiverDocumentStatus = 'generating' | 'ready' | 'failed' | 'voided'
export type NotificationDeliveryStatus =
  | 'pending'
  | 'processing'
  | 'retry_scheduled'
  | 'sent'
  | 'failed'

export type Organization = {
  id: string
  name: string
  slug: string
  created_by: string
  created_at: string
  updated_at: string
}

export type OrganizationMembership = {
  organization_id: string
  user_id: string
  role: OrganizationRole
  status: 'invited' | 'active' | 'suspended'
  created_at: string
  updated_at: string
}

export type OrganizationMember = {
  user_id: string
  email: string
  role: OrganizationRole
  status: 'invited' | 'active' | 'suspended'
  created_at: string
  updated_at: string
}

export type Project = {
  id: string
  organization_id: string
  name: string
  code: string
  status: ProjectStatus
  created_by: string
  created_at: string
  updated_at: string
}

export type Subcontractor = {
  id: string
  organization_id: string
  user_id: string | null
  company_name: string
  contact_name: string | null
  email: string | null
  status: SubcontractorStatus
  created_by: string
  created_at: string
  updated_at: string
}

export type SubcontractorPayoutAccount = {
  id: string
  organization_id: string
  subcontractor_id: string
  dashboard_type: 'express' | 'full' | 'none'
  onboarding_status: PayoutOnboardingStatus
  livemode: boolean
  details_submitted: boolean
  charges_enabled: boolean
  payouts_enabled: boolean
  requirements_currently_due: string[]
  requirements_eventually_due: string[]
  requirements_past_due: string[]
  disabled_reason: string | null
  last_synced_at: string | null
  created_at: string
  updated_at: string
}

export type ProjectSubcontractor = {
  organization_id: string
  project_id: string
  subcontractor_id: string
  assigned_by: string
  assigned_at: string
}

export type PaymentRequest = {
  id: string
  organization_id: string
  project_id: string
  subcontractor_id: string
  created_by: string
  approved_by: string | null
  description: string
  gross_amount: number
  retainage_basis_points: number
  retainage_amount: number
  net_amount: number
  currency: string
  status: PaymentRequestStatus
  submitted_at: string | null
  approved_at: string | null
  checkout_started_at: string | null
  paid_at: string | null
  failed_at: string | null
  refunded_amount: number
  refunded_at: string | null
  created_at: string
  updated_at: string
}

export type AuditEvent = {
  id: number
  organization_id: string
  actor_user_id: string | null
  action: string
  entity_type: string
  entity_id: string | null
  metadata: Json
  created_at: string
}

export type Payment = {
  id: number
  user_id: string | null
  organization_id: string | null
  payment_request_id: string | null
  reference: string
  product_name: string
  unit_amount: number
  quantity: number
  amount_total: number
  currency: string
  status: PaymentStatus
  stripe_checkout_session_id: string | null
  stripe_payment_intent_id: string | null
  customer_email: string | null
  paid_at: string | null
  amount_refunded: number
  refunded_at: string | null
  destination_charge: boolean
  created_at: string
  updated_at: string
}

export type PaymentRefund = {
  id: number
  organization_id: string
  payment_id: number
  payment_request_id: string
  reference: string
  stripe_refund_id: string | null
  amount: number
  currency: string
  status: RefundStatus
  reason: string
  requested_by: string | null
  failure_reason: string | null
  completed_at: string | null
  created_at: string
  updated_at: string
}

export type StripeWebhookFailure = {
  id: number
  organization_id: string | null
  event_id: string
  event_type: string
  object_id: string | null
  error_code: string | null
  error_message: string
  attempts: number
  first_failed_at: string
  last_failed_at: string
  resolved_at: string | null
  resolution: string | null
}

export type WaiverDocument = {
  id: string
  organization_id: string
  payment_request_id: string
  payment_id: number
  storage_path: string
  file_name: string
  mime_type: 'application/pdf'
  status: WaiverDocumentStatus
  generated_by: string | null
  generated_at: string | null
  voided_at: string | null
  void_reason: string | null
  sha256: string | null
  file_size: number | null
  failure_reason: string | null
  generation_token: string | null
  generation_started_at: string | null
  created_at: string
  updated_at: string
}

export type NotificationDelivery = {
  id: string
  organization_id: string
  payment_request_id: string
  notification_type: 'payment_request_approved' | 'payment_succeeded'
  recipient_email: string | null
  recipient_name: string
  subject: string
  template_data: Json
  status: NotificationDeliveryStatus
  attempt_count: number
  max_attempts: number
  idempotency_key: string
  provider_message_id: string | null
  worker_token: string | null
  next_attempt_at: string | null
  last_attempt_at: string | null
  sent_at: string | null
  error_code: string | null
  error_message: string | null
  created_at: string
  updated_at: string
}

export interface Database {
  public: {
    Tables: {
      organizations: {
        Row: Organization
        Insert: {
          id?: string
          name: string
          slug: string
          created_by: string
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Organization>
        Relationships: []
      }
      organization_memberships: {
        Row: OrganizationMembership
        Insert: OrganizationMembership
        Update: Partial<OrganizationMembership>
        Relationships: []
      }
      projects: {
        Row: Project
        Insert: {
          id?: string
          organization_id: string
          name: string
          code: string
          status?: ProjectStatus
          created_by?: string
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Project>
        Relationships: []
      }
      subcontractors: {
        Row: Subcontractor
        Insert: {
          id?: string
          organization_id: string
          user_id?: string | null
          company_name: string
          contact_name?: string | null
          email?: string | null
          status?: SubcontractorStatus
          created_by?: string
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Subcontractor>
        Relationships: []
      }
      subcontractor_payout_accounts: {
        Row: SubcontractorPayoutAccount
        Insert: Record<string, never>
        Update: Record<string, never>
        Relationships: []
      }
      project_subcontractors: {
        Row: ProjectSubcontractor
        Insert: {
          organization_id: string
          project_id: string
          subcontractor_id: string
          assigned_by?: string
          assigned_at?: string
        }
        Update: never
        Relationships: []
      }
      payment_requests: {
        Row: PaymentRequest
        Insert: Record<string, never>
        Update: Record<string, never>
        Relationships: []
      }
      audit_events: {
        Row: AuditEvent
        Insert: Record<string, never>
        Update: Record<string, never>
        Relationships: []
      }
      payments: {
        Row: Payment
        Insert: Omit<Payment, 'id' | 'created_at' | 'updated_at'> & {
          id?: number
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Payment>
        Relationships: []
      }
      stripe_webhook_events: {
        Row: {
          id: number
          event_id: string
          type: string
          processed_at: string
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: number
          event_id: string
          type: string
          processed_at?: string
          created_at?: string
          updated_at?: string
        }
        Update: Record<string, never>
        Relationships: []
      }
      payment_refunds: {
        Row: PaymentRefund
        Insert: Record<string, never>
        Update: Record<string, never>
        Relationships: []
      }
      stripe_webhook_failures: {
        Row: StripeWebhookFailure
        Insert: Record<string, never>
        Update: Record<string, never>
        Relationships: []
      }
      waiver_documents: {
        Row: WaiverDocument
        Insert: Record<string, never>
        Update: Record<string, never>
        Relationships: []
      }
      notification_deliveries: {
        Row: NotificationDelivery
        Insert: Record<string, never>
        Update: Record<string, never>
        Relationships: []
      }
    }
    Views: Record<string, never>
    Functions: {
      organization_role: {
        Args: { p_organization_id: string }
        Returns: OrganizationRole | null
      }
      is_organization_member: {
        Args: { p_organization_id: string }
        Returns: boolean
      }
      has_organization_role: {
        Args: { p_organization_id: string; p_roles: string[] }
        Returns: boolean
      }
      create_organization: {
        Args: { p_name: string; p_slug: string }
        Returns: string
      }
      create_organization_workspace: {
        Args: { p_name: string; p_slug: string; p_seed_demo?: boolean }
        Returns: string
      }
      seed_demo_organization: {
        Args: { p_organization_id: string }
        Returns: Json
      }
      get_demo_workspace_status: {
        Args: { p_organization_id: string }
        Returns: {
          status: 'active'
          can_remove: boolean
          reason: string | null
        }[]
      }
      remove_demo_workspace_data: {
        Args: { p_organization_id: string }
        Returns: Json
      }
      list_organization_members: {
        Args: { p_organization_id: string }
        Returns: OrganizationMember[]
      }
      upsert_organization_member: {
        Args: {
          p_organization_id: string
          p_email: string
          p_role: Exclude<OrganizationRole, 'owner'>
        }
        Returns: string
      }
      set_organization_member_status: {
        Args: {
          p_organization_id: string
          p_user_id: string
          p_status: 'active' | 'suspended'
        }
        Returns: boolean
      }
      prepare_subcontractor_payout_onboarding: {
        Args: {
          p_subcontractor_id: string
          p_user_id: string
        }
        Returns: {
          payout_account_id: string
          organization_id: string
          subcontractor_id: string
          company_name: string
          contact_email: string | null
          stripe_account_id: string | null
        }[]
      }
      create_payment_request: {
        Args: {
          p_organization_id: string
          p_project_id: string
          p_subcontractor_id: string
          p_description: string
          p_gross_amount: number
          p_retainage_basis_points: number
          p_currency: string
        }
        Returns: string
      }
      submit_payment_request: {
        Args: { p_payment_request_id: string }
        Returns: boolean
      }
      approve_payment_request: {
        Args: { p_payment_request_id: string }
        Returns: boolean
      }
      transition_payment_request_status: {
        Args: {
          p_payment_request_id: string
          p_next_status: string
          p_actor_user_id?: string | null
          p_metadata?: Json
        }
        Returns: boolean
      }
      prepare_payment_request_checkout: {
        Args: {
          p_payment_request_id: string
          p_user_id: string
          p_reference: string
        }
        Returns: {
          payment_id: number
          payment_reference: string
          organization_id: string
          payment_request_id: string
          request_description: string
          project_name: string
          subcontractor_name: string
          amount_total: number
          currency: string
          customer_email: string | null
          stripe_checkout_session_id: string | null
          stripe_destination_account_id: string
          destination_charge: boolean
        }[]
      }
      attach_payment_checkout_session: {
        Args: { p_reference: string; p_session_id: string }
        Returns: boolean
      }
      mark_payment_checkout_failed: {
        Args: { p_reference: string; p_reason?: string }
        Returns: boolean
      }
      consume_edge_rate_limit: {
        Args: {
          p_bucket: string
          p_subject: string
          p_limit: number
          p_window_seconds: number
        }
        Returns: boolean
      }
      process_stripe_webhook: {
        Args: {
          p_event_id: string
          p_event_type: string
          p_session_id: string | null
          p_payment_status: string | null
          p_payment_intent_id: string | null
          p_customer_email: string | null
        }
        Returns: boolean
      }
      prepare_payment_refund: {
        Args: {
          p_payment_request_id: string
          p_user_id: string
          p_reference: string
        }
        Returns: {
          refund_reference: string
          organization_id: string
          payment_request_id: string
          payment_reference: string
          stripe_payment_intent_id: string
          stripe_refund_id: string | null
          amount: number
          currency: string
          refund_status: RefundStatus
          destination_charge: boolean
        }[]
      }
      apply_payment_refund_status: {
        Args: {
          p_refund_reference: string
          p_stripe_refund_id: string | null
          p_status: RefundStatus
          p_failure_reason?: string | null
          p_actor_user_id?: string | null
        }
        Returns: boolean
      }
      record_stripe_webhook_failure: {
        Args: {
          p_event_id: string
          p_event_type: string
          p_object_id: string | null
          p_error_code: string | null
          p_error_message: string
        }
        Returns: boolean
      }
      resolve_stripe_webhook_failure: {
        Args: { p_event_id: string; p_resolution?: string }
        Returns: boolean
      }
      process_stripe_refund_webhook: {
        Args: {
          p_event_id: string
          p_event_type: string
          p_stripe_refund_id: string
          p_refund_reference: string | null
          p_payment_intent_id: string | null
          p_amount: number
          p_currency: string
          p_status: RefundStatus
          p_failure_reason: string | null
        }
        Returns: boolean
      }
      prepare_payment_reconciliation: {
        Args: { p_payment_request_id: string; p_user_id: string }
        Returns: {
          payment_reference: string
          organization_id: string
          payment_request_id: string
          stripe_checkout_session_id: string
          stripe_payment_intent_id: string | null
        }[]
      }
      reconcile_stripe_payment: {
        Args: {
          p_payment_request_id: string
          p_user_id: string
          p_session_status: string
          p_payment_status: string
          p_payment_intent_id: string | null
          p_refunds?: Json
        }
        Returns: PaymentStatus
      }
      claim_notification_delivery: {
        Args: { p_payment_request_id: string; p_user_id?: string | null }
        Returns: {
          delivery_id: string
          worker_token: string
          notification_type: NotificationDelivery['notification_type']
          recipient_email: string
          recipient_name: string
          subject: string
          template_data: Json
          idempotency_key: string
          attempt_count: number
          max_attempts: number
        }[]
      }
      complete_notification_delivery: {
        Args: {
          p_delivery_id: string
          p_worker_token: string
          p_provider_message_id: string
        }
        Returns: boolean
      }
      fail_notification_delivery: {
        Args: {
          p_delivery_id: string
          p_worker_token: string
          p_error_code: string
          p_error_message: string
          p_retryable: boolean
        }
        Returns: NotificationDeliveryStatus
      }
      retry_notification_delivery: {
        Args: { p_delivery_id: string; p_user_id: string }
        Returns: string
      }
      reserve_waiver_document: {
        Args: { p_payment_request_id: string; p_user_id: string }
        Returns: {
          document_id: string
          document_status: WaiverDocumentStatus
          storage_path: string
          file_name: string
          organization_id: string
          organization_name: string
          payment_request_id: string
          payment_reference: string
          project_name: string
          project_code: string
          subcontractor_name: string
          subcontractor_contact: string | null
          description: string
          gross_amount: number
          retainage_amount: number
          net_amount: number
          currency: string
          paid_at: string
        }[]
      }
      finalize_waiver_document: {
        Args: {
          p_document_id: string
          p_user_id: string
          p_sha256: string
          p_file_size: number
        }
        Returns: boolean
      }
      fail_waiver_document: {
        Args: { p_document_id: string; p_failure_reason: string }
        Returns: boolean
      }
      prepare_waiver_download: {
        Args: { p_payment_request_id: string; p_user_id: string }
        Returns: {
          document_id: string
          storage_path: string
          file_name: string
        }[]
      }
    }
    Enums: Record<string, never>
    CompositeTypes: Record<string, never>
  }
}
