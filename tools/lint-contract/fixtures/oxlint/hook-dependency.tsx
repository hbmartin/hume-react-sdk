import { useEffect } from 'react';

export const ContractComponent = ({ value }: { value: string }) => {
  useEffect(() => {
    console.log(value);
  }, []);
  return null;
};
