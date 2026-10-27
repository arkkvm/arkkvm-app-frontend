/**
 * @Purpose:
 * @Descripttion:
 * @version:
 * @Author: zhanglei
 * @Date: 2025-10-27 16:25:25
 * @LastEditors: zhanglei
 * @LastEditTime: 2026-05-28 14:38:36
 */
import { request } from '@/api';
import { Button, Input, WelcomeBackground } from '@/components';

import { parseVersions } from '@/utils/parse';
import { normalizeDeviceId } from '@/utils/security';
import React, { useCallback, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
export const meta = {
  path: '/devices/:id/set-name',
  cloudPath: '/devices/:id/set-name',
  target: 'cloud',
};
export default function setName() {
  const { id: rawId } = useParams();
  const id = normalizeDeviceId(rawId);

   const navigate = useNavigate();
  const [name, setName] = useState('');
  interface FormErrors {
    name?: string
    res?: string
  }
  const [errors, setErrors] = useState<FormErrors>({});
  const validate = (): FormErrors => {
    const newErrors: FormErrors = {};
    if (!name) {
      newErrors.name = 'Name is required';
    }
    return newErrors;
  };
  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setName(event.target.value);
  };
  const submitHandle = useCallback(async () => {
    if (!id) { navigate('/devices/list', { replace: true }); return; }
    const newErrors = validate();
    setErrors({});
    if (Object.keys(newErrors).length) {
      setErrors(newErrors);
    } else {
      const { success } = await request.put(`/devices/${id}`, { name: name });
      if (success) {
        const { data } = await request.get(`/devices/${id}`);
        const deviceData = data as { cloudVersion?: unknown } | undefined;
        const cloudVersion = parseVersions(deviceData?.cloudVersion);
        const targetUrl = `/${encodeURIComponent(cloudVersion || 'v-default')}/device/${encodeURIComponent(id)}?deviceName=${encodeURIComponent(name)}`;
        navigate(targetUrl,{ replace: true });
      }
    }
  }, [name, id, navigate]);
  return (
    <WelcomeBackground
      title="Name Your Device"
      subtitle={[
        'Give your KVM device a friendly name so you can easily find and manage it in the cloud.',
      ]}
    >
      <div className="w-[350px]">
        <Input
          label="Device Name"
          labelPosition="top"
          labelSize={14}
          placeholder="Device Name (Hostname or Asset Tag)"
          value={name}
          size="lg"
          onChange={handleChange}
          allowChinese
          className="my-[14px]"
        ></Input>
        <div className="text-[12px]">
          {errors.name && <span className="error-text">{errors.name}</span>}
          {errors.res && <span className="error-text">{errors.res}</span>}
        </div>
        <Button
          variant="primary"
          onClick={submitHandle}
          className="w-full"
          size="lg"
        >
          Save & Continue
        </Button>
      </div>
    </WelcomeBackground>
  );
}
